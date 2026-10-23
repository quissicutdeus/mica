// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EXPIRED } from '../lib/statuses';
import { PlayerFacingError } from '../lib/errors';
import { defineService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { appEventChannel } from '../lib/appEvents';
import { openRow, openRows, storablePlaintext } from '../lib/contentCipher';
import { evidenceHold, RETENTION_BATCH } from '../lib/contentRetention';
import { whenSchemaReady } from '../lib/schemaReady';
import { isAppDisabled } from '../lib/ownerConfig';
import { pageBounds } from '../lib/payload';
import { fail, guardedAsync, ok, publish, rateLimited, type ExportOutcome } from '../lib/exports';
import { registerExportFilter } from './Privacy';
import {
  ALIAS_MAX,
  DARKCHAT_APP,
  aliasIsLive,
  liveCitizensOf,
  liveMember,
  liveChannelByCode,
  normalizeCode,
  updateInBatches
} from './Darkchat';
import { darkchatMessagesContract } from '@mica/shared/contracts/darkchat_messages';
import type { DarkchatMessage } from '@mica/shared/types';
import { reasonOf, traceOf } from '../lib/sqlErrors';

const TABLE = 'mica_darkchat_messages';

/** The contract's bound on a body, and the plaintext bound a sealed one is held to. */
export const BODY_MAX = 500;

// ---------------------------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------------------------

export const RETENTION_CONVAR = 'mica_darkchat_retention';
export const DEFAULT_RETENTION_HOURS = 24;

/** The last raw value read and what it resolved to, so a bad value is said once, not per read. */
let resolved: { raw: string; hours: number } | null = null;

/**
 * How long a message lives, in whole hours: `mica_darkchat_retention`, read on every use so a
 * change takes effect without a restart. At least one, default 24, and **no off switch** — a
 * Dark Chat that kept everything would not be one. A value that is not a whole number of hours
 * of at least one warns and uses the default, rather than reading as "forever" or as "zero".
 */
export const retentionHours = (): number => {
  const raw =
    typeof GetConvar === 'function'
      ? GetConvar(RETENTION_CONVAR, String(DEFAULT_RETENTION_HOURS))
      : String(DEFAULT_RETENTION_HOURS);
  if (resolved?.raw === raw) return resolved.hours;
  const text = raw.trim();
  let hours = DEFAULT_RETENTION_HOURS;
  if (text === '') {
    hours = DEFAULT_RETENTION_HOURS;
  } else if (/^\d+$/.test(text) && Number.parseInt(text, 10) >= 1) {
    hours = Math.min(Number.parseInt(text, 10), 24 * 365);
  } else {
    console.warn(
      `[darkchat] ${RETENTION_CONVAR} is '${raw}', which is not a whole number of hours of at ` +
        `least 1; using ${DEFAULT_RETENTION_HOURS}. Dark Chat has no off switch.`
    );
  }
  resolved = { raw, hours };
  return hours;
};

/** Tests only: forget the resolved window. */
export const __resetDarkchatRetention = (): void => {
  resolved = null;
};

/**
 * Inside the window. Every read of a message carries this — the page, the report's visibility
 * rule, the data export — so a row the sweep has not reached yet is still never answered.
 */
export const INSIDE_WINDOW = '`created_at` > NOW() - INTERVAL ? HOUR';

// ---------------------------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------------------------

interface MessageRow {
  id: number;
  citizenid: string;
  channel_id: number;
  author_member_id: number | null;
  bot_alias: string | null;
  body: string;
  status: string;
  created_at: Date | string;
}

/**
 * The reporter's alias in the reported message's channel, for `mica_reports.reporter_label`:
 * what Admin shows as who reported it, since the alias is the only name the reporter had there.
 */
const reporterAlias = async (targetId: number, citizenid: string): Promise<string | null> => {
  // Sealed to the member and the channel (MICA-432): read with both, and opened.
  const row = await Database.single<{
    citizenid: string;
    channel_id: number;
    alias: string;
  } | null>(
    `SELECT mem.\`citizenid\`, mem.\`channel_id\`, mem.\`alias\` FROM \`${TABLE}\` msg
     JOIN \`mica_darkchat_members\` mem
       ON mem.\`channel_id\` = msg.\`channel_id\` AND mem.\`citizenid\` = ? AND mem.\`left_at\` IS NULL
     WHERE msg.\`id\` = ? LIMIT 1`,
    [citizenid, targetId]
  );
  if (!row) return null;
  const alias = openRow('mica_darkchat_members', row).alias;
  return typeof alias === 'string' ? alias : null;
};

/**
 * Messages in a Dark Chat channel (MICA-254).
 *
 * Membership on both axes, through the channel's members table: `isMember` asks for a member row
 * with `left_at` NULL, which a leave and a removal both set, so neither a former nor a removed
 * member is one. `citizenid` is the author, never projected; `author_member_id` is the identity a
 * reader sees, through that member row's alias.
 *
 * A line from the `PostToDarkChat` export has no member: `author_member_id` is NULL, `bot_alias`
 * names it, and `citizenid` is the channel owner's at the time, so the row has an owner for the
 * purge and the sweep. Such a line cannot be reported: its words are a server script's, and the
 * report would name the channel owner as their author.
 *
 * No generic action, no edit, no delete, no reactions, no media. A message leaves when its
 * window passes (`sweepDarkchat`) or when staff moderate it.
 */
export const darkchatMessages = defineService<MessageRow, typeof darkchatMessagesContract>({
  contract: darkchatMessagesContract,
  id: 'darkchat_messages',
  app: DARKCHAT_APP,
  table: TABLE,
  reportable: { label: 'Dark Chat message', previewColumn: 'body', reporterLabel: reporterAlias },
  access: {
    read: 'members',
    write: 'members',
    membership: {
      table: 'mica_darkchat_members',
      foreignKey: 'channel_id',
      localKey: 'channel_id',
      liveWhileNull: 'left_at'
    }
  },
  paging: { pageSize: 50, maxPageSize: 100 },
  // `expired`: the retention window passed (MICA-428), never a player's own delete.
  statuses: ['active', 'deleted', 'moderated', EXPIRED],
  /** Bound to the author's citizenid and the channel, as a message is to its conversation. */
  encryptionScope: ['channel_id'],
  schema: {
    channel_id: {
      type: 'int',
      notNull: true,
      clientWritable: false,
      references: { table: 'mica_darkchat', column: 'id' }
    },
    /** The member row that wrote it; NULL on an export's line. */
    author_member_id: {
      type: 'int',
      clientWritable: false,
      references: { table: 'mica_darkchat_members', column: 'id' }
    },
    /** What an export's line is signed as; NULL on a member's. Sealed at rest (MICA-431). */
    bot_alias: { type: 'string', length: ALIAS_MAX, clientWritable: false, encrypted: true },
    /** Sealed at rest (MICA-165). At most `BODY_MAX` characters, by the contract and the export. */
    body: { type: 'text', notNull: true, encrypted: true, clientWritable: false }
  },
  indexes: [
    /** The page: `channel_id = ? AND id < ? ORDER BY id DESC`, one backward range scan. */
    { name: 'channel_id_id', columns: ['channel_id', 'id'] },
    /** The sweep's walk, oldest first. */
    { name: 'created_at', columns: ['created_at'] }
  ]
});

const app = darkchatMessages.app;
const repo = darkchatMessages.repo;
const channel = appEventChannel(DARKCHAT_APP);

const paging = darkchatMessages.resolved.paging;
if (!paging) throw new Error("defineService('darkchat_messages'): a channel read must page.");

/**
 * One row as a reader sees it: no citizenid, no member row id — the author's handle stands in for
 * it — and `mine` for this reader, decided here from the row ids the server keeps to itself.
 */
const toWire = (
  row: MessageRow & { member_alias?: string | null; member_handle?: string | null },
  myMemberId: number | null
): DarkchatMessage => {
  const authorId = row.author_member_id === null ? null : Number(row.author_member_id);
  return {
    id: Number(row.id),
    channel_id: Number(row.channel_id),
    member_id: authorId === null ? null : String(row.member_handle ?? ''),
    alias: String(authorId === null ? (row.bot_alias ?? '') : (row.member_alias ?? '')),
    bot: authorId === null,
    mine: authorId !== null && authorId === myMemberId,
    body: String(row.body),
    created_at: row.created_at
  };
};

const notMember = () =>
  new PlayerFacingError('You are not in that channel.', { key: 'server.darkchat.notMember' });

app.registerEvent('list', async (_source, _cbId, data, citizenid) => {
  const member = await liveMember(data.channel_id, citizenid);
  if (!member) throw notMember();

  const { limit, cursor } = pageBounds(data, paging);
  const params: unknown[] = [data.channel_id, retentionHours()];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  // `citizenid` is selected only so a sealed body opens; `toWire` drops it. The table is named
  // literally so `encryptedColumns.test.ts` sees this read and holds it to the `openRows` below.
  const cursorClause = cursor === null ? '' : ' AND msg.`id` < ?';
  const selected = await Database.query<
    (MessageRow & {
      member_alias: string | null;
      member_handle: string | null;
      member_citizenid: string | null;
    })[]
  >(
    `SELECT msg.\`id\`, msg.\`citizenid\`, msg.\`channel_id\`, msg.\`author_member_id\`,
            msg.\`bot_alias\`, msg.\`body\`, msg.\`created_at\`, mem.\`alias\` AS member_alias,
            mem.\`handle\` AS member_handle, mem.\`citizenid\` AS member_citizenid
     FROM \`mica_darkchat_messages\` msg
     LEFT JOIN \`mica_darkchat_members\` mem ON mem.\`id\` = msg.\`author_member_id\`
     WHERE msg.\`channel_id\` = ? AND msg.\`status\` = 'active'
       AND msg.\`created_at\` > NOW() - INTERVAL ? HOUR${cursorClause}
     ORDER BY msg.\`id\` DESC
     LIMIT ?`,
    params
  );
  // The author's alias and handle are sealed to the author's member row (MICA-432): opened off
  // its citizenid and the channel, then dropped with it — `toWire` never sees whose they are.
  const rows = openRows(TABLE, selected ?? []).map((row) => {
    const { member_citizenid: author, ...rest } = row;
    if (author === null || author === undefined) return rest;
    const writer = openRow('mica_darkchat_members', {
      citizenid: author,
      channel_id: row.channel_id,
      alias: row.member_alias,
      handle: row.member_handle
    });
    return { ...rest, member_alias: writer.alias, member_handle: writer.handle };
  });
  const hasMore = rows.length > limit;
  const shown = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: shown.map((row) => toWire(row, member.id)),
    nextCursor: hasMore ? Number(shown[shown.length - 1].id) : null
  };
});

/**
 * Tell the channel's other live members, after the write and never failing it. The toast says
 * only that something arrived — no body, no channel name, no alias — and is not stored, so the
 * notification shade keeps no trace of a channel the retention window has already forgotten.
 */
const announce = (message: DarkchatMessage, except: string | null): void => {
  void liveCitizensOf(message.channel_id)
    .then((citizens) => {
      const to = citizens.filter((id) => id !== except);
      if (to.length === 0) return;
      channel.pushMany(
        to,
        'message',
        { channel_id: message.channel_id, message: { ...message, mine: false } },
        {
          notify: { type: 'info', title: 'Dark Chat', message: 'New message' },
          persist: false
        }
      );
    })
    .catch((error: unknown) => {
      const line = reasonOf(error);
      console.error(`[darkchat] push for message ${message.id} failed: ${line}`);
    });
};

app.registerEvent('send', async (_source, _cbId, data, citizenid) => {
  const member = await liveMember(data.channel_id, citizenid);
  if (!member) throw notMember();

  const body = data.body.trim();
  if (!body) {
    throw new PlayerFacingError('Type a message first.', { key: 'server.darkchat.emptyMessage' });
  }

  const id = await repo.create({
    citizenid,
    channel_id: data.channel_id,
    author_member_id: member.id,
    body: await storablePlaintext(body, BODY_MAX)
  } as Partial<MessageRow>);

  const message: DarkchatMessage = {
    id,
    channel_id: data.channel_id,
    member_id: member.handle,
    alias: member.alias,
    bot: false,
    mine: true,
    body,
    created_at: new Date().toISOString()
  };
  try {
    announce(message, citizenid);
  } catch (error) {
    console.error('[darkchat] push failed for message', id, traceOf(error));
  }
  return message;
});

// A phone in hand, server-side: a message is published to the channel (MICA-339).
app.requirePhoneFor('send');

// ---------------------------------------------------------------------------------------------
// The export: a server script posts to a channel
// ---------------------------------------------------------------------------------------------

/** Per calling resource. A job script announcing a shift fits; a stuck loop does not. */
const POST_PER_MINUTE = 30;

type Posted = { messageId: number };

/**
 * `PostToDarkChat(code, alias, body)`: a line from a server script, signed `alias`, in the live
 * channel `code` opens. Not reachable from any net event — another resource calls it.
 *
 * Refused when the alias is a live member's in that channel, compared as the members key
 * compares: a script must not be able to put words in a member's mouth. The row is owned by the
 * channel's owner, and `author_member_id` NULL marks it as no member's.
 */
const PostToDarkChat = async (
  code: unknown,
  alias: unknown,
  body: unknown
): Promise<ExportOutcome<Posted>> => {
  // Read first, before any await: FiveM answers the invoking resource only during the
  // synchronous part of the export call, and '' (or null) once it has yielded.
  const invoker = GetInvokingResource();
  if (isAppDisabled(DARKCHAT_APP)) {
    return fail<Posted>(
      'app_disabled',
      `The owner has turned '${DARKCHAT_APP}' off on this server.`
    );
  }
  const normalized = typeof code === 'string' ? normalizeCode(code) : null;
  if (!normalized) return fail<Posted>('invalid_args', 'A channel code is required.');
  const signed = typeof alias === 'string' ? alias.trim() : '';
  if (!signed || signed.length > ALIAS_MAX) {
    return fail<Posted>('invalid_args', `An alias of 1 to ${ALIAS_MAX} characters is required.`);
  }
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text || text.length > BODY_MAX) {
    return fail<Posted>('invalid_args', `A body of 1 to ${BODY_MAX} characters is required.`);
  }

  // By the code's blind index (MICA-432): the code itself is sealed.
  const found = await liveChannelByCode(normalized);
  if (!found) return fail<Posted>('invalid_args', 'No live channel has that code.');
  const channelId = Number(found.id);

  if (await aliasIsLive(channelId, signed)) {
    return fail<Posted>('invalid_args', 'A member of that channel goes by that alias.');
  }

  const id = await repo.create({
    citizenid: String(found.citizenid),
    channel_id: channelId,
    bot_alias: signed,
    body: await storablePlaintext(text, BODY_MAX)
  } as Partial<MessageRow>);

  console.log(`[darkchat] '${invoker || 'unknown'}' posted message ${id} to channel ${channelId}.`);
  announce(
    {
      id,
      channel_id: channelId,
      member_id: null,
      alias: signed,
      bot: true,
      mine: false,
      body: text,
      created_at: new Date().toISOString()
    },
    null
  );
  return ok({ messageId: id });
};

publish(
  'PostToDarkChat',
  guardedAsync('PostToDarkChat', rateLimited('PostToDarkChat', POST_PER_MINUTE, PostToDarkChat))
);

// ---------------------------------------------------------------------------------------------
// The export filter: a player's data export carries only what is still inside the window
// ---------------------------------------------------------------------------------------------

registerExportFilter(TABLE, () => ({ sql: INSIDE_WINDOW, params: [retentionHours()] }));

// ---------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------

/** Every fifteen minutes, so a message outlives its window by at most that. */
export const SWEEP_INTERVAL_MS = 15 * 60_000;

let sweeping = false;

/**
 * Expire the messages past the window (MICA-428): `active` to `expired`, kept for staff and
 * hidden from every player. A message a pending report names stays as it is until the report
 * resolves, and a takedown's `moderated` one is never moved (MICA-426). Nothing is deleted.
 *
 * Its own sweep rather than a `contentRetention` policy: that one is measured in days, with a
 * day's grace and a six-hour interval, so a 24-hour message would live up to about two and a
 * half days. The hold is the same predicate (`evidenceHold`), so a reported or moderated
 * message is held by one definition; once a reopen puts it back, the next sweep expires it by
 * its window, so a line that would have expired anyway stays expired. Ids are selected, then
 * exactly those ids moved with the window and the hold asked again, so a report filed between
 * the two wins. `updated_at` is pinned: expiring is not an edit.
 *
 * Never rejects; returns the messages expired.
 */
export const sweepDarkchat = async (): Promise<number> => {
  if (sweeping) return 0;
  sweeping = true;
  let removed = 0;
  try {
    const hours = retentionHours();
    const selectHold = evidenceHold(TABLE, 't');
    const deleteHold = evidenceHold(TABLE, `\`${TABLE}\``);
    removed = await updateInBatches(
      {
        sql: `SELECT t.\`id\` FROM \`${TABLE}\` t
         WHERE t.\`status\` = 'active' AND t.\`created_at\` < NOW() - INTERVAL ? HOUR
           AND ${selectHold.sql}
         ORDER BY t.\`created_at\`, t.\`id\` LIMIT ${RETENTION_BATCH}`,
        params: [hours, ...selectHold.params]
      },
      (ids) => ({
        sql:
          `UPDATE \`${TABLE}\` SET \`status\` = ?, \`updated_at\` = \`updated_at\` ` +
          `WHERE \`id\` IN (${ids.map(() => '?').join(', ')}) AND \`status\` = 'active' ` +
          `AND \`created_at\` < NOW() - INTERVAL ? HOUR AND ${deleteHold.sql} LIMIT ${RETENTION_BATCH}`,
        params: [EXPIRED, ...ids, hours, ...deleteHold.params]
      })
    );
    if (removed > 0) console.log(`[darkchat] expired ${removed} message(s) past ${hours}h.`);
  } catch (error) {
    // The driver's last line only: an oxmysql error embeds the statement and its parameters.
    const line = reasonOf(error);
    console.error(`[darkchat] sweep failed: ${line}`);
  } finally {
    sweeping = false;
  }
  return removed;
};

let timer: ReturnType<typeof setInterval> | undefined;

/** Start the sweep: once now, then every `SWEEP_INTERVAL_MS`. Idempotent. */
export const startDarkchatSweep = (): void => {
  if (timer !== undefined) return;
  console.log(`[darkchat] messages last ${retentionHours()} hour(s).`);
  timer = setInterval(() => void sweepDarkchat(), SWEEP_INTERVAL_MS);
  void sweepDarkchat();
};

/** Tests only. */
export const __resetDarkchatSweep = (): void => {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  sweeping = false;
};

/** The resource-start hook, exported so a test can drive it. */
export const onDarkchatResourceStart = (resourceName: string): void => {
  if (resourceName !== GetCurrentResourceName()) return;
  // After the first-start schema check (MICA-306), and not at all if it refused.
  whenSchemaReady(startDarkchatSweep);
};

on('onResourceStart', onDarkchatResourceStart);
