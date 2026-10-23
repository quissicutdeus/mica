// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

/**
 * Every `status` ENUM as MICA-428 shipped it, frozen: a migration means what it ran, whatever the
 * declarations say later. `erased` on every status table, `expired` on the five a timer hides.
 * Each list is the one before it with new values appended, never reordered, so the change is
 * MariaDB's in-place ENUM append and no row is rewritten.
 */
const STATUSES: Readonly<Record<string, readonly string[]>> = {
  mica_accounts: ['active', 'deleted', 'moderated', 'erased'],
  mica_battery: ['active', 'deleted', 'erased'],
  mica_blabber: ['active', 'deleted', 'moderated', 'erased'],
  mica_blabber_dms: ['active', 'deleted', 'moderated', 'expired', 'erased'],
  mica_blocklist: ['active', 'deleted', 'erased'],
  mica_casino_rounds: ['active', 'settled', 'deleted', 'erased'],
  mica_contacts: ['active', 'deleted', 'moderated', 'erased'],
  mica_darkchat: ['active', 'deleted', 'erased'],
  mica_darkchat_members: ['active', 'left', 'removed', 'erased'],
  mica_darkchat_messages: ['active', 'deleted', 'moderated', 'expired', 'erased'],
  mica_devices: ['active', 'deleted', 'erased'],
  mica_glimpse: ['active', 'deleted', 'moderated', 'erased'],
  mica_glimpse_comments: ['active', 'deleted', 'moderated', 'erased'],
  mica_highscores: ['active', 'deleted', 'erased'],
  mica_hodlr: ['active', 'deleted', 'erased'],
  mica_import_ledger: ['active', 'deleted', 'erased'],
  mica_invoices: ['active', 'paid', 'declined', 'expired', 'deleted', 'erased'],
  mica_lockscreen: ['active', 'deleted', 'erased'],
  mica_mail: ['active', 'archived', 'deleted', 'moderated', 'erased'],
  mica_marketplace: ['active', 'sold', 'removed', 'moderated', 'deleted', 'erased'],
  mica_media: ['active', 'deleted', 'moderated', 'expired', 'erased'],
  mica_messages: ['active', 'deleted', 'moderated', 'expired', 'erased'],
  mica_messages_conversations: ['active', 'archived', 'deleted', 'moderated', 'erased'],
  mica_messages_participants: ['active', 'left', 'removed', 'moderated', 'erased'],
  mica_notes: ['active', 'archived', 'deleted', 'moderated', 'erased'],
  mica_notifications: ['active', 'deleted', 'moderated', 'expired', 'erased'],
  mica_phone_call_log: ['active', 'deleted', 'moderated', 'erased'],
  mica_phone_numbers: ['active', 'deleted', 'erased'],
  mica_places: ['active', 'deleted', 'moderated', 'erased'],
  mica_reports: ['active', 'deleted', 'erased'],
  mica_settings: ['active', 'deleted', 'erased'],
  mica_spark: ['active', 'deleted', 'moderated', 'erased']
};

/**
 * The generated unique keys MICA-428 restates, frozen as the declarations have them now.
 *
 * - **Two that read "not deleted" as live**, now "not deleted, expired or erased": Blabber's
 *   one-mouth-per-account and Spark's one-profile-per-citizen. Otherwise an `erased` or
 *   `expired` row would hold its slot for good: a Spark profile erased by a player's privacy
 *   delete would refuse them a new one, and an erased mouth the same Blab mouthed again.
 * - **Four that were over the plain owner or phone**, now over a copy of it that an erased row
 *   does not carry: Hodlr's one holding, the one score per game, the one setting per phone and
 *   key, the one block per phone and number. Otherwise an upsert or a revive after a privacy
 *   delete met the erased row under the key and brought it back, overwriting the evidence. A
 *   `deleted` row still holds these: bringing one back is what `put` and the revive are for.
 * - **The one membership per phone and thread**, over a copy of the phone an erased membership
 *   does not carry. The handover leaves an erased membership naming its real member, so a dead
 *   character's would otherwise refuse the phone's next holder the same thread for good.
 */
const KEYS: readonly {
  table: string;
  column: string;
  /** The column's type, or the column whose type it copies: 60 wide on ESX for a citizenid. */
  type: string | 'citizenid' | 'device_id';
  expression: string;
  key: { name: string; columns: string };
  /** The key this one replaces, dropped in the same statement. */
  replaces?: string;
  /**
   * The column a fresh import has it after, so an upgraded table's columns read in the same
   * order. Only when that column is there: the additive pass, which adds a missing one, runs
   * after the migrations.
   */
  after: string;
}[] = [
  {
    table: 'mica_blabber',
    column: 'mouth_key',
    after: 'root_id',
    type: 'int(11)',
    expression:
      "CASE WHEN `status` NOT IN ('deleted', 'expired', 'erased') THEN `mouth_of` ELSE NULL END",
    key: { name: 'account_mouth_key', columns: '`account_id`, `mouth_key`' }
  },
  {
    table: 'mica_spark',
    column: 'live_citizen',
    after: 'looking_for',
    type: 'citizenid',
    expression:
      "CASE WHEN `status` NOT IN ('deleted', 'expired', 'erased') THEN `citizenid` ELSE NULL END",
    key: { name: 'live_citizen', columns: '`live_citizen`' }
  },
  {
    table: 'mica_hodlr',
    column: 'live_citizen',
    after: 'quantity',
    type: 'citizenid',
    expression: "CASE WHEN `status` <> 'erased' THEN `citizenid` ELSE NULL END",
    key: { name: 'live_citizen', columns: '`live_citizen`' },
    replaces: 'citizenid_unique'
  },
  {
    table: 'mica_highscores',
    column: 'live_citizen',
    after: 'score',
    type: 'citizenid',
    expression: "CASE WHEN `status` <> 'erased' THEN `citizenid` ELSE NULL END",
    key: { name: 'live_citizen_app', columns: '`live_citizen`, `app`' },
    replaces: 'citizenid_app'
  },
  {
    table: 'mica_settings',
    column: 'live_device',
    after: 'setting_value',
    type: 'device_id',
    expression: "CASE WHEN `status` <> 'erased' THEN `device_id` ELSE NULL END",
    key: { name: 'live_device_app_key', columns: '`live_device`, `app`, `setting_key`' },
    replaces: 'device_app_key'
  },
  {
    table: 'mica_messages_participants',
    column: 'live_device',
    after: 'device_id',
    type: 'device_id',
    expression: "CASE WHEN `status` <> 'erased' THEN `device_id` ELSE NULL END",
    key: { name: 'conversation_live_device', columns: '`conversation_id`, `live_device`' },
    replaces: 'conversation_device_unique'
  },
  {
    table: 'mica_blocklist',
    column: 'live_device',
    after: 'number',
    type: 'device_id',
    expression: "CASE WHEN `status` <> 'erased' THEN `device_id` ELSE NULL END",
    key: { name: 'live_device_number', columns: '`live_device`, `number`' },
    replaces: 'device_number_unique'
  }
];

/** A column type this migration will restate: an int, or a varchar of a plain width. */
const PLAIN_TYPE = /^(int\(\d+\)|varchar\(\d+\))$/;

/** An expression as `information_schema` reads back, for comparing: lower case, no spaces. */
const normalized = (expression: string): string => expression.toLowerCase().replace(/\s+/g, '');

/** Migrations do not share code; these are copies on purpose, as 0001's are. */
const count = async (sql: string, params: unknown[]): Promise<number> =>
  Number(await Database.scalar<number>(sql, params)) || 0;

const hasTable = async (table: string): Promise<boolean> =>
  (await count(
    'SELECT COUNT(*) FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = ?',
    [table]
  )) > 0;

const hasIndex = async (table: string, index: string): Promise<boolean> =>
  (await count(
    'SELECT COUNT(*) FROM information_schema.STATISTICS WHERE table_schema = DATABASE() ' +
      'AND table_name = ? AND index_name = ?',
    [table, index]
  )) > 0;

const column = async (
  table: string,
  name: string
): Promise<{ type: string; generation: string } | null> => {
  const row = await Database.single<Record<string, unknown>>(
    `SELECT COLUMN_TYPE AS \`type\`, GENERATION_EXPRESSION AS \`generation\`
       FROM information_schema.COLUMNS
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, name]
  );
  if (!row) return null;
  return { type: String(row.type ?? ''), generation: String(row.generation ?? '') };
};

/** The values of an `enum('a','b')` column type, as information_schema spells it. */
const enumValues = (type: string): string[] | null => {
  const match = /^enum\((.*)\)$/i.exec(type.trim());
  if (!match) return null;
  return [...match[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
};

/**
 * Append what `wanted` adds to a table's `status` ENUM. Refused, before anything is written to
 * that table, when what is there is not a prefix of it — a value this does not know, or the
 * same values in another order — since a MODIFY over it would remap or reject live rows.
 */
const widenStatus = async (table: string, wanted: readonly string[]): Promise<void> => {
  const current = await column(table, 'status');
  if (!current) return;
  const values = enumValues(current.type);
  if (!values) {
    throw new Error(`${table}.status is '${current.type}', not an ENUM; change it by hand.`);
  }
  if (values.length === wanted.length && values.every((v, i) => v === wanted[i])) return;
  if (values.length > wanted.length || values.some((v, i) => v !== wanted[i])) {
    throw new Error(
      `${table}.status holds (${values.join(', ')}), which is not the start of ` +
        `(${wanted.join(', ')}); append the missing values by hand, in that order.`
    );
  }
  const list = wanted.map((value) => `'${value}'`).join(', ');
  await Database.query(
    `ALTER TABLE \`${table}\` MODIFY COLUMN \`status\` ENUM(${list}) NOT NULL DEFAULT 'active'`,
    []
  );
};

/**
 * Restate a generated unique key's column, unless it already reads the expression and the key
 * it replaces is gone. One statement, so there is no moment with no unique key on a live
 * server: drop the old key, drop the column, add both back. Dropped and added rather than
 * `MODIFY`'d: MariaDB recomputing a virtual column in place was measured filling it with
 * garbage bytes (0014). A virtual column holds nothing to lose, and every new key only ever
 * narrows what holds a slot, so no row the old key allowed can collide under the new one.
 */
const rekey = async (spec: (typeof KEYS)[number]): Promise<void> => {
  const current = await column(spec.table, spec.column);
  const keyed = await hasIndex(spec.table, spec.key.name);
  const replaced = spec.replaces ? await hasIndex(spec.table, spec.replaces) : false;
  const restated = current
    ? normalized(current.generation).includes(normalized(spec.expression))
    : false;
  if (restated && keyed && !replaced) return;
  // The width of the column it copies as it is now: a citizenid is `varchar(50)` on qb and
  // `varchar(60)` once 0004 has widened it on ESX. A copy, so the key compares like the base.
  const type =
    spec.type === 'citizenid' || spec.type === 'device_id'
      ? ((await column(spec.table, spec.type))?.type.toLowerCase() ?? '')
      : spec.type;
  const placed = (await column(spec.table, spec.after)) !== null;
  if (!PLAIN_TYPE.test(type)) {
    throw new Error(
      `${spec.table}.${spec.column} would be '${type}', which this migration will not restate; ` +
        'change it by hand, as the declaration says.'
    );
  }
  await Database.query(
    `ALTER TABLE \`${spec.table}\` ` +
      [
        ...(keyed ? [`DROP KEY \`${spec.key.name}\``] : []),
        ...(replaced ? [`DROP KEY \`${spec.replaces}\``] : []),
        ...(current ? [`DROP COLUMN \`${spec.column}\``] : []),
        `ADD COLUMN \`${spec.column}\` ${type} GENERATED ALWAYS AS (${spec.expression}) VIRTUAL` +
          (placed ? ` AFTER \`${spec.after}\`` : ''),
        `ADD UNIQUE KEY \`${spec.key.name}\` (${spec.key.columns})`
      ].join(', '),
    []
  );
};

/**
 * MICA-428: nothing is ever hard deleted. Retention, the purges and the player deletes that
 * removed rows now move them to a status, and the rows stay for evidence. Two new values say who
 * hid a row, beside the player's own `deleted` and staff's `moderated`:
 *
 * - `expired`, on the five tables a timer hides (messages, DMs, media, Dark Chat messages,
 *   notifications);
 * - `erased`, on every status table: the privacy delete, the character-deleted purge, the
 *   orphan sweep and `micaseed clear`.
 *
 * And the unique keys (`KEYS`): Blabber's and Spark's free a slot on `expired` and `erased` as
 * on `deleted`, and Hodlr's, the highscores', the settings' and the blocklist's are over a copy
 * of the owner or phone that an erased row does not carry, so an erased row is never revived or
 * overwritten.
 *
 * **Safe to run twice**: each table's ENUM and each key is read first. A table this server
 * never created is skipped.
 */
export const migration: Migration = {
  id: '0015_hidden_rows_are_kept',
  description:
    "Every status ENUM gains 'erased', and the five retained tables 'expired'; seven unique " +
    'keys stop holding a slot for an erased row (Blabber, Spark, Hodlr, highscores, settings, ' +
    'thread memberships, blocklist)',
  up: async () => {
    for (const [table, wanted] of Object.entries(STATUSES)) {
      if (await hasTable(table)) await widenStatus(table, wanted);
    }
    for (const spec of KEYS) {
      if (await hasTable(spec.table)) await rekey(spec);
    }
  }
};
