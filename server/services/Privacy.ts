// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ServiceEndpoint } from '../lib/ServiceEndpoint';
import { PlayerFacingError } from '../lib/errors';
import { Database } from '../lib/Database';
import { AUDIT_LOG_TABLE, AuditLogger } from '../lib/AuditLogger';
import { VERSIONS_TABLE } from '../lib/versions';
import { declaredServices, type ColumnDef, type ColumnType } from '../lib/defineService';
import {
  SEAL_KEY_COLUMN,
  blindIndexesOf,
  contextColumns,
  encryptedColumnsOf,
  openRow,
  plaintextBytesSql
} from '../lib/contentCipher';
import {
  ownedTables,
  purgeOwnedRows,
  type OwnedTable,
  type PurgeException
} from '../lib/orphanSweep';
import { PRIVACY_DELETE_CONFIRMATION, privacyContract } from '@mica/shared/contracts/privacy';
import type { PrivacyDeleteResult, PrivacyExport, PrivacyExportCategory } from '@mica/shared/types';
import { traceOf } from '../lib/sqlErrors';

/**
 * A player's own data: export all of it, or delete all of it (MICA-168).
 *
 * A service of its own rather than two more actions on `settings`, whose table it does not
 * read any more than it reads the other twenty. It declares no `app`: the UI lives in Settings,
 * which cannot be turned off, and a player's right to their own data must not be either — so it
 * belongs in `NEVER_REFUSED_SERVICES` (`lib/ownerConfig.ts`).
 *
 * **Both halves walk `ownedTables()`**, the set the character-deleted purge and the orphan
 * sweep walk, so what a player can see and what a player can delete are the same set by
 * construction. Delete does not have a deleter of its own: it is `purgeOwnedRows`, with the
 * open-report evidence hold (MICA-292) inside it.
 *
 * The citizenid is the authenticated session's, always. Neither payload names a player.
 */
const app = new ServiceEndpoint<never, typeof privacyContract>('privacy', null, {
  contract: privacyContract,
  // The citizen's data, whichever device asks: Settings > Your data ships on both (MICA-264).
  devices: ['phone', 'tablet'],
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

/**
 * Up to three exports per player per rolling minute. It reads every owned table, and the Your
 * data pane loads it on open, so a player closing and reopening the pane is not refused.
 */
export const EXPORT_INTERVAL_MS = 60_000;
export const EXPORT_BURST = 3;
/** One delete per player per hour: it deletes from every owned table. */
export const DELETE_INTERVAL_MS = 60 * 60_000;

/**
 * Rows per category. Past this a category is cut and marked `'rows'`, and the query asks for
 * one more than this so "exactly the cap" and "more than the cap" are told apart.
 */
export const ROW_CAP = 1000;

/**
 * The whole export's budget, in characters of row JSON — about 1 MiB for ASCII. The reply
 * crosses a reliable net event and then NUI, and one player's notification history should not
 * be able to make that the size of the disk. Categories past the budget are marked `'size'`.
 */
export const EXPORT_LIMIT_CHARS = 1024 * 1024;

/**
 * Keyed by **citizenid**, not source: FiveM recycles server ids, so a source-keyed window is
 * one reconnect away from resetting (the same reason as `Lockscreen.ts`'s lockout). On top of
 * the transport limiter in `lib/rateLimit.ts`, not instead of it.
 */
/** Each player's successful exports within the last `EXPORT_INTERVAL_MS`, oldest first. */
const recentExports = new Map<string, number[]>();
const lastDelete = new Map<string, number>();

let now: () => number = () => Date.now();
/** Test seam, matching `__setRateLimitClock`. */
export const __setPrivacyClock = (fn?: () => number): void => {
  now = fn ?? (() => Date.now());
};
export const __resetPrivacyLimits = (): void => {
  recentExports.clear();
  lastDelete.clear();
  inFlight.clear();
};

/**
 * Milliseconds until `citizenid` may act again, or 0. Only reads the window: an attempt is
 * charged by `charge`, and only once it has succeeded — a delete that failed part-way leaves
 * the player free to retry the part that failed, and an export that failed returned nothing.
 */
const waitFor = (windows: Map<string, number>, interval: number, citizenid: string): number => {
  const last = windows.get(citizenid);
  const at = now();
  return last !== undefined && at - last < interval ? interval - (at - last) : 0;
};

const charge = (windows: Map<string, number>, citizenid: string): void => {
  windows.set(citizenid, now());
};

/**
 * Who has an export or a delete running. Charging only on success leaves a window open while
 * the first request is in flight; this closes it, so two concurrent requests are one request
 * and a refusal, never two purges.
 */
const inFlight = new Set<string>();

/** Milliseconds until the oldest export in the window leaves it, or 0 while under the burst. */
const exportWait = (citizenid: string): number => {
  const at = now();
  const recent = (recentExports.get(citizenid) ?? []).filter((t) => at - t < EXPORT_INTERVAL_MS);
  recentExports.set(citizenid, recent);
  return recent.length < EXPORT_BURST ? 0 : EXPORT_INTERVAL_MS - (at - recent[0]);
};

const chargeExport = (citizenid: string): void => {
  recentExports.set(citizenid, [...(recentExports.get(citizenid) ?? []), now()]);
};

const busy = (): PlayerFacingError =>
  new PlayerFacingError('Already working on that. Try again in a moment.', {
    key: 'server.privacy.busy'
  });

// ---------------------------------------------------------------------------------------------
// What an export may contain
// ---------------------------------------------------------------------------------------------

/**
 * A column whose name says it is a credential. Withheld on any table, including an add-on's
 * this file has never seen: `mica_lockscreen.passcode_hash` and `passcode_salt` today.
 * A hash of a player's own passcode is still a hash somebody can brute-force offline, and the
 * export is designed to be copied out of the game.
 */
const CREDENTIAL = /(^|_)(hash|salt|token|secret|password|passcode|pin|credential|api_key)(_|$)/;

/**
 * Column types that hold media bytes. Exported as `<column>_bytes`, the size, and never the
 * bytes: `mica_media.data`/`thumbnail` (base64 photos) and `mica_contacts.avatar` (a blob).
 * A hosted photo's `url` is a string column and is kept.
 */
const BYTE_TYPES: ReadonlySet<ColumnType> = new Set<ColumnType>(['blob', 'mediumtext']);

/**
 * Withheld per table, where the name alone does not say it: the two phones of a 1:1 thread
 * and their pair key name the *other* party's device (the conversation is the player's; the
 * other phone is not), and a report's preview is the reported player's words.
 */
const WITHHELD: Readonly<Record<string, readonly string[]>> = {
  mica_messages_conversations: ['participant_a', 'participant_b', 'pair_key'],
  // A snapshot of the reported content, which is the reported player's, not the reporter's —
  // and the status its takedown replaced (MICA-386), which says whether its author deleted it.
  mica_reports: ['target_preview', 'target_prior_status'],
  // MICA-335. `phone_key` is `phone` again while the row is live, and NULL otherwise: the
  // unique key's machinery, telling the player nothing `phone` and `status` do not.
  mica_contacts: ['phone_key'],
  // MICA-335. Whether the device's new-device hooks still owe it a run: the server's own
  // bookkeeping, not anything the player made.
  mica_devices: ['setup_pending'],
  // MICA-358. What a row costs against the media quota: size bookkeeping the server keeps so
  // the quota need not measure every photo. The export already gives each byte column's size.
  mica_media: ['stored_bytes'],
  // MICA-330. `mouth_key` is `mouth_of` again while the mouth is live, and NULL otherwise: the
  // unique key's machinery, telling the player nothing `mouth_of` and `status` do not.
  mica_blabber: ['mouth_key'],
  // MICA-428. `live_device` is `device_id` again while the row is not erased, and NULL
  // otherwise: the unique key's machinery, as `phone_key` is. (Hodlr's and the highscores'
  // `live_citizen` is a citizenid column and withheld as one.)
  mica_settings: ['live_device'],
  mica_blocklist: ['live_device'],
  mica_messages_participants: ['live_device'],
  // MICA-429. `live_message` is `message_id` again while the reaction stands, and NULL
  // otherwise: the unique key's machinery, telling the player nothing the two columns do not.
  mica_messages_reactions: ['live_message'],
  // MICA-254. A Dark Chat channel's join code: a key to a room other people speak in, which an
  // export copied out of the game would hand to whoever reads the file. The owner reads it in
  // the app. `alias_key` is the alias again while the member is live (`live_citizen`, its twin,
  // is a citizenid column and withheld as one). `handle` is what the channel knew the member by
  // in place of the alias row's id: kept out of a file whose whole point is to name the player.
  mica_darkchat: ['code'],
  mica_darkchat_members: ['handle', 'alias_key']
};

// ---------------------------------------------------------------------------------------------
// What stays: moderation and accountability records
// ---------------------------------------------------------------------------------------------

/**
 * Owned tables the export leaves out entirely.
 *
 * `mica_audit_logs` is the moderation ledger. A row is keyed by whoever *acted*, so a staff
 * member's rows describe admin reads and moderation of other players' content, and even
 * without `details` the targets are somebody else's. It is a record about the player, kept
 * for accountability, not the player's own content.
 *
 * `mica_versions` is what an edit replaced (MICA-430), kept for staff. A player sees only the
 * latest version of their own content, in the app and in this export alike; what came before is
 * evidence, read only through `reports:versions`. A privacy delete erases it with the rest.
 */
export const EXPORT_EXCLUDED: ReadonlySet<string> = new Set([AUDIT_LOG_TABLE, VERSIONS_TABLE]);

/**
 * What a player's own delete keeps (MICA-168). The test for each: is this a moderation or
 * accountability record, rather than content the player made? The character-deleted purge
 * and the orphan sweep pass three of these -- the audit ledger and pending reports, which
 * outlive the character (MICA-300), and the phone number, which is never issued again
 * (MICA-440; `CHARACTER_EXCEPT` in `lib/shell.ts`); the rest only a self-service delete keeps.
 *
 * - `mica_audit_logs`, whole: the moderation ledger. A staff member must not be able to
 *   erase the record of their own moderation and admin reads (MICA-70).
 * - `mica_reports`, the pending ones: a report the player filed that staff have not resolved.
 *   Deleting it would release the evidence hold on the content it names, which is the one
 *   thing the hold exists to stop. A resolved report is the player's own row and goes. The
 *   predicate is retention's `OPEN_REPORT` (`lib/contentRetention.ts`) over this table's own
 *   row, spelled out because an `UPDATE` cannot read its own table through a subquery.
 * - `mica_invoices`, the open ones: a bill somebody else issued to the player and they have
 *   not paid. Deleting it would be walking away from the debt. A paid, declined or expired
 *   invoice is the player's history and goes.
 * - `mica_devices`, `mica_phone_numbers`, `mica_battery`, `mica_lockscreen`, whole: the
 *   device's identity and state, not the player's content. Deleting them under a live session
 *   desyncs it — the number registry and the lock keep the old row, and a number could be
 *   reassigned while its holder still has the phone open. They stay in the export. A deleted
 *   character has no session, so its purge erases all but the number (MICA-440).
 * - `mica_import_ledger`, whole: the operator's record of what `micaimport` brought over. It
 *   is how a re-run knows a row was already imported, so deleting it would let the next run
 *   bring the deleted data straight back.
 */
export const SELF_SERVICE_EXCEPT: readonly PurgeException[] = [
  { table: AUDIT_LOG_TABLE },
  {
    table: 'mica_reports',
    keep: (row) => ({
      sql: `${row}.\`status\` = 'active' AND ${row}.\`resolution\` = 'pending'`,
      params: []
    })
  },
  {
    table: 'mica_invoices',
    keep: (row) => ({ sql: `${row}.\`status\` = 'active'`, params: [] })
  },
  { table: 'mica_import_ledger' },
  // The device, not the player's content — see the list above.
  { table: 'mica_devices' },
  { table: 'mica_phone_numbers' },
  { table: 'mica_battery' },
  { table: 'mica_lockscreen' }
];

interface ColumnSpec {
  name: string;
  type: ColumnType;
  /** Another player's identity when it is not the table's owner column. */
  citizenId: boolean;
}

const asDef = (spec: ColumnType | ColumnDef): ColumnDef =>
  typeof spec === 'string' ? { type: spec } : spec;

const specOf = (name: string, spec: ColumnType | ColumnDef): ColumnSpec => {
  const def = asDef(spec);
  return { name, type: def.type, citizenId: def.citizenId === true };
};

/** Every column of an owned table, from the declaration that made it. Null if none did. */
const columnsOf = (table: string): readonly ColumnSpec[] | null => {
  for (const service of declaredServices) {
    if (service.table === table) {
      const declared = new Map(service.fields.map(({ name, def }) => [name, def]));
      return service.columns.map((name) => {
        const def = declared.get(name);
        return def ? specOf(name, def) : { name, type: 'string', citizenId: false };
      });
    }
    for (const child of service.childTables) {
      if (child.name !== table) continue;
      const cols = Object.entries(child.columns).map(([name, spec]) => specOf(name, spec));
      return child.autoIncrementId === false
        ? cols
        : [{ name: 'id', type: 'int', citizenId: false }, ...cols];
    }
  }
  return null;
};

export interface ExportPlan {
  table: string;
  owner: string;
  /** Selected as-is. */
  plain: string[];
  /** Selected as `LENGTH(col) AS col_bytes`. */
  sized: string[];
  withheld: string[];
  ordered: boolean;
  /** The `plain` columns sealed at rest (MICA-165), opened before the row is handed back. */
  sealed: string[];
  /**
   * Selected only so the `sealed` ones can be opened — their citizenid and scope — and
   * dropped from the row afterwards, so opening changes nothing else about the export.
   */
  context: string[];
  /**
   * The table has a status, so the export leaves out what an erase hid (MICA-428): erased rows
   * are kept for staff and shown to no player, their owner included, here as everywhere.
   *
   * **Only `erased`.** An `expired` row is still stored and still the player's own — a window
   * hid it from the app, nobody asked for it to be gone — so it stays in their export, as a
   * `deleted` or `moderated` one always has.
   */
  hidesErased: boolean;
}

/**
 * What one table's export selects. Pure, and exported so the suite can hold every owned table
 * to "no credential, no bytes, no other player's citizenid" without a database.
 *
 * The owner column is dropped rather than withheld: it is the player's own citizenid on
 * every row, and repeating it a thousand times tells them nothing.
 */
export const planFor = ({ table, column }: OwnedTable): ExportPlan | null => {
  const columns = columnsOf(table);
  if (!columns) return null;
  // The server's own lookup and binding columns (MICA-432) — a value's blind index, a row's seal
  // key — say nothing a player wrote, and a blind index is no use to anyone outside the server.
  const extra = new Set([
    ...(WITHHELD[table] ?? []),
    ...blindIndexesOf(table).map((entry) => entry.index),
    SEAL_KEY_COLUMN
  ]);
  const plan: ExportPlan = {
    table,
    owner: column,
    plain: [],
    sized: [],
    withheld: [],
    ordered: columns.some(({ name }) => name === 'id'),
    sealed: [],
    context: [],
    hidesErased: columns.some(({ name }) => name === 'status')
  };
  for (const { name, type, citizenId } of columns) {
    if (name === column) continue;
    if (citizenId || extra.has(name) || CREDENTIAL.test(name)) plan.withheld.push(name);
    else if (BYTE_TYPES.has(type)) plan.sized.push(name);
    else plan.plain.push(name);
  }
  // A player's export is their words, not ciphertext: every sealed column it returns is opened,
  // and whatever opening needs that the export does not show is selected beside it.
  const sealed = encryptedColumnsOf(table).filter((entry) => plan.plain.includes(entry.column));
  plan.sealed = sealed.map((entry) => entry.column);
  plan.context = [...new Set(sealed.flatMap(contextColumns))].filter(
    (name) => !plan.plain.includes(name)
  );
  return plan;
};

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Only declared names reach here; checked anyway, since they are interpolated (§2.9). */
const ident = (name: string): string => {
  if (!SAFE_IDENTIFIER.test(name)) throw new Error(`privacy: refusing identifier '${name}'`);
  return `\`${name}\``;
};

/** A row filter on one table's export: SQL over the table's own unqualified columns. */
export type ExportFilter = () => { sql: string; params: unknown[] };

const exportFilters = new Map<string, ExportFilter>();

/**
 * Narrow one table's export to the rows a player may still be shown (MICA-254): Dark Chat's
 * messages export only inside their retention window, as every read of them answers only inside
 * it. Registered by the owning service, not imported here, for the reason
 * `onBeforeSelfServiceDelete` is. The filter is asked on every export, so a window read from a
 * convar is the window now.
 *
 * Its SQL is the service's own, never a payload's; it may name only the table's columns.
 */
export const registerExportFilter = (table: string, filter: ExportFilter): void => {
  if (exportFilters.has(table)) {
    throw new Error(`registerExportFilter: '${table}' already has a filter.`);
  }
  exportFilters.set(table, filter);
};

/** The registered filter for `table`, resolved now; null when it has none. */
export const exportFilterFor = (table: string): { sql: string; params: unknown[] } | null => {
  const filter = exportFilters.get(table);
  return filter ? filter() : null;
};

export const exportSql = (plan: ExportPlan, filter: string | null = null): string => {
  const sealedHere = new Set(encryptedColumnsOf(plan.table).map((entry) => entry.column));
  const select = [
    ...plan.plain.map(ident),
    ...plan.context.map(ident),
    // A sealed column's size is its plaintext's (MICA-431): what the player stored, not the
    // ciphertext, which reads a third high.
    ...plan.sized.map(
      (name) =>
        `${sealedHere.has(name) ? plaintextBytesSql(ident(name)) : `LENGTH(${ident(name)})`} ` +
        `AS ${ident(`${name}_bytes`)}`
    )
  ];
  return (
    `SELECT ${select.length > 0 ? select.join(', ') : '1 AS `present`'} FROM ${ident(plan.table)} ` +
    `WHERE ${ident(plan.owner)} = ?` +
    `${plan.hidesErased ? " AND `status` <> 'erased'" : ''}` +
    `${filter ? ` AND (${filter})` : ''}` +
    `${plan.ordered ? ' ORDER BY `id`' : ''} LIMIT ?`
  );
};

const categoryOf = (table: string): string => table.replace(/^mica_/, '');

/**
 * Every category an export can return, in order. The web labels each from its own catalog
 * (`yourData.cat.<category>` in the Settings app), and `privacyLabels.test.ts` holds the two
 * catalogs to this list so a new owned table cannot arrive unlabelled.
 */
export const exportCategories = (): string[] =>
  ownedTables()
    .filter(({ table }) => !EXPORT_EXCLUDED.has(table))
    .map(({ table }) => categoryOf(table));

/** One exported row with its sealed columns opened and the context selected for them dropped. */
const openForExport = (plan: ExportPlan, row: Record<string, unknown>): Record<string, unknown> => {
  const opened = { ...openRow(plan.table, row) };
  for (const name of plan.context) delete opened[name];
  return opened;
};

/** Build the export for one citizenid. Exported for the suite; the handler is a thin wrapper. */
export const buildExport = async (citizenid: string): Promise<PrivacyExport> => {
  const categories: PrivacyExportCategory[] = [];
  let spent = 0;
  let truncated = false;

  for (const owned of ownedTables()) {
    if (EXPORT_EXCLUDED.has(owned.table)) continue;
    const category = categoryOf(owned.table);
    const entry: PrivacyExportCategory = {
      category,
      rows: [],
      truncated: false,
      withheld: []
    };
    categories.push(entry);

    const plan = planFor(owned);
    if (!plan) {
      // Unreachable while `ownedTables` derives from the same declarations; if it ever is
      // not, the category says it was not exported rather than looking empty.
      console.error(`[privacy] ${owned.table} is owned but undeclared; not exported.`);
      entry.truncated = 'rows';
      truncated = true;
      continue;
    }
    entry.withheld = plan.withheld;

    if (spent >= EXPORT_LIMIT_CHARS) {
      entry.truncated = 'size';
      truncated = true;
      continue;
    }

    const filter = exportFilterFor(owned.table);
    const rows = await Database.query<Record<string, unknown>[]>(
      exportSql(plan, filter?.sql ?? null),
      [citizenid, ...(filter?.params ?? []), ROW_CAP + 1]
    );
    if (!Array.isArray(rows)) throw new Error(`privacy: ${owned.table} answered no rows array`);

    for (const selected of rows.slice(0, ROW_CAP)) {
      const row = plan.sealed.length > 0 ? openForExport(plan, selected) : selected;
      const size = JSON.stringify(row).length;
      if (spent + size > EXPORT_LIMIT_CHARS) {
        entry.truncated = 'size';
        spent = EXPORT_LIMIT_CHARS;
        break;
      }
      spent += size;
      entry.rows.push(row);
    }
    if (!entry.truncated && rows.length > ROW_CAP) entry.truncated = 'rows';
    if (entry.truncated) truncated = true;
  }

  return {
    generatedAt: new Date(now()).toISOString(),
    limitChars: EXPORT_LIMIT_CHARS,
    truncated,
    categories
  };
};

type BeforeSelfServiceDelete = (citizenid: string) => Promise<void>;
const beforeDeleteHooks: { name: string; run: BeforeSelfServiceDelete }[] = [];

/**
 * Work a service must do before a player's own delete purges their rows, while those rows
 * still exist to say what they were (MICA-342). `Conversations.ts` is the one user: it unpairs
 * every 1:1 the player is about to be taken out of.
 *
 * Registered here rather than imported, for the reason `onDeviceCreated` is registered.
 * `Conversations.ts` reaches `lib/shell.ts` through `Devices.ts`, and `lib/shell.ts` imports this
 * file, so importing it here would close a cycle. A hook that throws fails the whole delete
 * before anything is purged, so the player's retry starts clean.
 */
export const onBeforeSelfServiceDelete = (name: string, run: BeforeSelfServiceDelete): void => {
  beforeDeleteHooks.push({ name, run });
};

/**
 * A player's own delete: `purgeCascadeSafe` (`lib/orphanSweep.ts`), keeping what
 * `SELF_SERVICE_EXCEPT` keeps, what an open report holds and what hangs off it, and never
 * following a cascade into a row it would not delete itself. The `onBeforeSelfServiceDelete`
 * hooks run first.
 *
 * Only this purge runs them. The character-deleted purge and the start-up sweep
 * (`lib/shell.ts`) erase the phone too (MICA-440), so a 1:1 pair they leave behind names a phone
 * nobody resolves to again: since MICA-438 an item opens its holder's own phone, and a new ESX
 * character in the slot is given a new one. The other party's thread with it stays as it was.
 * That case is not handled here.
 */
export const selfServicePurge = async (citizenid: string) => {
  for (const hook of beforeDeleteHooks) {
    try {
      await hook.run(citizenid);
    } catch (error) {
      console.error(`[privacy] ${hook.name}'s work before the delete failed; nothing purged.`);
      throw error;
    }
  }
  return await purgeOwnedRows(citizenid, { except: SELF_SERVICE_EXCEPT });
};

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

app.registerEvent('export', async (_source, _cbId, _data, citizenid) => {
  const waitMs = exportWait(citizenid);
  if (waitMs > 0) {
    const seconds = Math.ceil(waitMs / 1000);
    throw new PlayerFacingError(
      `You can export your data three times a minute. Try again in ${seconds}s.`,
      {
        key: 'server.privacy.exportTooSoon',
        params: { seconds }
      }
    );
  }

  const key = `export:${citizenid}`;
  if (inFlight.has(key)) throw busy();
  inFlight.add(key);
  let result: PrivacyExport;
  try {
    result = await buildExport(citizenid);
  } catch (error) {
    // A table that could not be read is not a table with nothing in it; the whole export is
    // refused rather than handed back with a hole that looks like an empty category.
    console.error('[privacy] export failed:', traceOf(error));
    throw new PlayerFacingError('Your data could not be exported. Try again later.', {
      key: 'server.privacy.exportFailed'
    });
  } finally {
    inFlight.delete(key);
  }
  chargeExport(citizenid);

  // Counts only. The ledger records that an export happened, never what was in it.
  // `viewed` because the ledger's `action` is an ENUM without a better member, and widening
  // it is a migration (see the MICA-168 report).
  await AuditLogger.log({
    citizenid,
    action: 'viewed',
    service: 'privacy',
    method: 'export',
    targetId: 0,
    details: {
      categories: result.categories.length,
      rows: result.categories.reduce((sum, c) => sum + c.rows.length, 0),
      truncated: result.truncated
    }
  });
  return result;
});

app.registerEvent('delete', async (_source, _cbId, data, citizenid) => {
  // Checked before the hour is spent: a typo is not a delete.
  if (data.confirm !== PRIVACY_DELETE_CONFIRMATION) {
    throw new PlayerFacingError(`Type ${PRIVACY_DELETE_CONFIRMATION} to confirm.`, {
      key: 'server.privacy.confirmRequired',
      params: { word: PRIVACY_DELETE_CONFIRMATION }
    });
  }

  const waitMs = waitFor(lastDelete, DELETE_INTERVAL_MS, citizenid);
  if (waitMs > 0) {
    const minutes = Math.ceil(waitMs / 60_000);
    throw new PlayerFacingError(
      `You can delete your data once an hour. Try again in ${minutes} min.`,
      { key: 'server.privacy.deleteTooSoon', params: { minutes } }
    );
  }

  const key = `delete:${citizenid}`;
  if (inFlight.has(key)) throw busy();
  inFlight.add(key);
  let purged: Awaited<ReturnType<typeof purgeOwnedRows>>;
  try {
    purged = await selfServicePurge(citizenid);
  } catch (error) {
    console.error('[privacy] delete failed:', traceOf(error));
    await AuditLogger.log({
      citizenid,
      action: 'deleted',
      service: 'privacy',
      method: 'delete',
      targetId: 0,
      details: { complete: false, removed: null, kept: null, failed: ['*'] }
    });
    throw new PlayerFacingError('Your data could not be deleted. Try again later.', {
      key: 'server.privacy.deleteFailed'
    });
  } finally {
    inFlight.delete(key);
  }

  const result: PrivacyDeleteResult = {
    complete: purged.failures.length === 0,
    // `removed` on the wire: what is gone from the player's phone. Kept, erased (MICA-428).
    removed: purged.erased,
    kept: purged.kept,
    failed: purged.failures.map(({ table }) => categoryOf(table))
  };
  // The hour is spent only on a delete that finished. A partial one is retried, and the
  // retry finds only what the failed tables still hold.
  if (result.complete) charge(lastDelete, citizenid);

  // Written after the purge, so the purge cannot take it: this row is the record that the
  // delete happened. Citizenid, time (the row's own `created_at`), counts, and whether
  // anything was kept (by the report hold or the cascade guard) — no content.
  await AuditLogger.log({
    citizenid,
    action: 'deleted',
    service: 'privacy',
    method: 'delete',
    targetId: 0,
    details: { ...result, held: result.kept === null ? null : result.kept > 0 }
  });
  return result;
});
