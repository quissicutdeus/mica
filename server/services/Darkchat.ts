// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ERASED } from '../lib/statuses';
import { randomBytes } from 'node:crypto';
import { PlayerFacingError } from '../lib/errors';
import { defineService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { AuditLogger } from '../lib/AuditLogger';
import { appEventChannel } from '../lib/appEvents';
import { isDuplicateKey, traceOf } from '../lib/sqlErrors';
import {
  BLIND_INDEX_WIDTH,
  blindIndexCandidates,
  blindIndexFor,
  blindIndexOf,
  newSealKey,
  openRow,
  openRows,
  sealRow,
  type BlindIndex
} from '../lib/contentCipher';
import { RETENTION_BATCH } from '../lib/contentRetention';
import { onBeforeSelfServiceDelete } from './Privacy';
import { registerSharedRows } from '../lib/orphanSweep';
import { defineContract, responseType } from '@mica/shared/contract';
import { s } from '@mica/shared/schema';
import type { DarkchatChannel, DarkchatJoined, DarkchatMember } from '@mica/shared/types';

/** The app id. Both Dark Chat services answer to it, so `mica_disabled_apps` turns off both. */
export const DARKCHAT_APP = 'darkchat';

export const CHANNEL_NAME_MAX = 32;
export const ALIAS_MAX = 24;
export const CODE_LENGTH = 8;

/**
 * What a join code is spelled in: no `0`/`O`, no `1`/`I`/`L`, because a code is read aloud and
 * typed from memory. Thirty-one symbols, so eight of them are about 2^39.6 codes — a guess per
 * failure budget (`JOIN_FAILURES`) is a rounding error against that.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const CODE_SHAPE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/**
 * A member's handle: what every reader is told a member is, in place of the row's id. Sixteen
 * symbols of the code alphabet, about 2^79, drawn per row. The integer id is a global sequence,
 * so handing it out would rank a channel's members by join order, mark its owner as the lowest,
 * and tie one player's aliases together across two channels they joined one after the other.
 */
export const HANDLE_LENGTH = 16;
const HANDLE_SHAPE = new RegExp(`^[${CODE_ALPHABET}]{${HANDLE_LENGTH}}$`);

const CHANNELS = 'mica_darkchat';
const MEMBERS = 'mica_darkchat_members';

/**
 * Dark Chat's channel contract (MICA-254), declared here beside its `defineService` for
 * Glimpse's reason: Dark Chat is `core: false`, and core may not name an app the Store installs
 * (`sdk/coreBoundary.test.ts`). The messages contract is in `shared/contracts/` because its id,
 * `darkchat_messages`, is not the add-on's.
 *
 * Every generic action is off. A channel is never read or written through the ownership path:
 * the owner is one row's `citizenid`, but who may see a channel is decided by its members table.
 *
 * None of these schemas authorizes anything. Every handler below decides from the session's
 * citizenid and the members table, never from an id in the payload (§2.9).
 */
const channelIdInput = s.positiveInt();
const aliasInput = s.string({ min: 1, max: ALIAS_MAX, trim: true });

export const darkchatContract = defineContract({
  id: 'darkchat',
  actions: {
    /** Open a channel and join it as its owner. The answer carries the join code. */
    create: {
      input: s.object({
        name: s.string({ min: 1, max: CHANNEL_NAME_MAX, trim: true }),
        alias: aliasInput
      }),
      output: responseType<DarkchatJoined>()
    },
    /**
     * Join by code. The code is matched case-blind with spaces and dashes dropped, so a code
     * read aloud as `ABCD-2345` works. Any failure to find a channel the caller may join is one
     * answer, which says nothing about whether the code exists.
     */
    join: {
      input: s.object({ code: s.string({ min: 1, max: 32, trim: true }), alias: aliasInput }),
      output: responseType<DarkchatJoined>()
    },
    /** The channels the caller is a live member of. */
    list: { input: s.object({}), output: responseType<DarkchatChannel[]>() },
    /** A channel's live members, by alias. The caller must be one of them. */
    members: {
      input: s.object({ channel_id: channelIdInput }),
      output: responseType<DarkchatMember[]>()
    },
    /** Leave. An owner who leaves hands the channel to its longest-standing live member. */
    leave: { input: s.object({ channel_id: channelIdInput }), output: responseType<boolean>() },
    /** The join code. Owner only. */
    code: {
      input: s.object({ channel_id: channelIdInput }),
      output: responseType<{ code: string }>()
    },
    /** A new join code; the old one stops working at once. Owner only. */
    rotateCode: {
      input: s.object({ channel_id: channelIdInput }),
      output: responseType<{ code: string }>()
    },
    /**
     * Remove a live member, who can never rejoin this channel. Owner only, never themself.
     * `member_id` is the member's handle, looked up inside this channel only.
     */
    removeMember: {
      input: s.object({
        channel_id: channelIdInput,
        member_id: s.string({ pattern: HANDLE_SHAPE })
      }),
      output: responseType<boolean>()
    }
  }
});

interface ChannelRow {
  id: number;
  citizenid: string;
  name: string;
  code: string;
  status: string;
}

/**
 * Dark Chat channels (MICA-254): a name, a private join code, and a members table in which each
 * member speaks under a per-channel alias.
 *
 * `citizenid` is the **owner**, the one row that may read and rotate the code or remove a
 * member. It moves when the owner leaves (`settleOwnership`), and no projection here carries it:
 * whether the caller owns a channel is computed in SQL as `is_owner`.
 *
 * **Membership follows the citizen, not the device.** No `deviceColumn`: Dark Chat's identity is
 * the alias, and a player who swaps phones keeps their channels, as they keep a Blabber account.
 * Deliberate for v1.
 */
export const darkchat = defineService<ChannelRow, typeof darkchatContract>({
  contract: darkchatContract,
  id: DARKCHAT_APP,
  app: DARKCHAT_APP,
  access: { read: 'owner', write: 'owner' },
  statuses: ['active', 'deleted'],
  /**
   * Sealed at rest (MICA-432), bound to the **channel** (`seal_key`), not to `citizenid`: the
   * owner passes to the next member (`settleOwnership`), and a name bound to the first owner
   * would stop opening for every member the day they left.
   */
  encryptionBinding: 'row',
  encryptionScope: [],
  schema: {
    name: {
      type: 'string',
      length: CHANNEL_NAME_MAX,
      notNull: true,
      clientWritable: false,
      encrypted: true
    },
    /**
     * The join code. Private, and never returned except by `create` and `code`/`rotateCode`,
     * which only the owner reaches. Sealed, so the owner can be shown it, and found by its blind
     * index, `code_index`, which a join matches (MICA-432). Unique forever, deleted channels
     * included — see below.
     */
    code: {
      type: 'string',
      length: CODE_LENGTH,
      notNull: true,
      clientWritable: false,
      private: true,
      encrypted: true,
      blindIndex: { normalize: (code) => normalizeCode(code) ?? code }
    }
  },
  indexes: [{ name: 'code_index', columns: ['code_index'], unique: true }],
  uniqueAfterDelete: {
    optOut:
      'a code is generated, never chosen: a create that meets a taken one draws another ' +
      "(`insertChannel`), so a deleted channel's code keeping its key only means no live " +
      'channel is ever reached by a code an old member still remembers'
  },
  childTables: [
    {
      name: MEMBERS,
      columns: {
        channel_id: {
          type: 'int',
          notNull: true,
          references: { table: CHANNELS, column: 'id' }
        },
        citizenid: { type: 'string', citizenId: true, notNull: true },
        /**
         * Sealed (MICA-432), bound to the member and their channel: the alias is the one name a
         * member has, and the row is the alias-to-character map. Found by `alias_index`, scoped
         * to the channel, as the alias is unique within one.
         */
        alias: {
          type: 'string',
          length: ALIAS_MAX,
          notNull: true,
          encrypted: true,
          blindIndex: { scope: ['channel_id'], normalize: (alias) => aliasKey(alias) }
        },
        /**
         * The handle readers know this member by (`HANDLE_LENGTH`). Drawn, never chosen. Sealed,
         * and found by `handle_index`, unique across every channel (MICA-432).
         */
        handle: {
          type: 'string',
          length: HANDLE_LENGTH,
          notNull: true,
          encrypted: true,
          blindIndex: {}
        },
        /**
         * `active` while live; `left` by the member's own leave; `removed` by the owner, which
         * also refuses every later join by the same citizen.
         */
        status: {
          type: 'enum',
          // `erased` (MICA-428): a purge hides a gone owner's memberships, never deletes them.
          values: ['active', 'left', 'removed', ERASED],
          notNull: true,
          default: 'active'
        },
        /** Membership is live while this is NULL (`liveWhileNull`). Set by leave and remove. */
        left_at: { type: 'timestamp' },
        created_at: { type: 'timestamp', notNull: true, defaultNow: true },
        /**
         * The alias's blind index while the member is live, NULL after (`alias` itself until
         * MICA-432 sealed it). Carries the unique key that makes an alias one person's among a
         * channel's live members, as `aliasKey` compares it: `Ghost` and `ghost` are the same
         * alias, which is the point when the alias is the only name. Restated, frozen, by
         * `0014_private_lookups_get_blind_indexes`.
         */
        alias_key: {
          type: 'string',
          length: BLIND_INDEX_WIDTH,
          generatedAs: 'CASE WHEN `left_at` IS NULL THEN `alias_index` ELSE NULL END'
        },
        /**
         * `citizenid` while the member is live, NULL after: at most one live membership per
         * citizen per channel. Without it two joins sent at once would seat one player under two
         * aliases, which is a sock puppet the channel could not tell apart.
         */
        live_citizen: {
          type: 'string',
          citizenId: true,
          generatedAs: 'CASE WHEN `left_at` IS NULL THEN `citizenid` ELSE NULL END'
        }
      },
      indexes: [
        { name: 'channel_alias', columns: ['channel_id', 'alias_key'], unique: true },
        { name: 'channel_citizen', columns: ['channel_id', 'live_citizen'], unique: true },
        { name: 'handle_index', columns: ['handle_index'], unique: true },
        { name: 'citizenid', columns: ['citizenid'] },
        /** The sweep's walk over rows whose member has gone. */
        { name: 'status_left_at', columns: ['status', 'left_at'] }
      ],
      encryptionScope: ['channel_id'],
      uniqueAfterDelete: {
        optOut:
          'a member row is never soft-deleted: leaving or removal sets `left_at`, which turns ' +
          'both generated keys NULL, and a rejoin is a new row; `handle` is drawn per row, and ' +
          'an insert that meets a taken one draws again (`insertMember`)'
      }
    }
  ],
  options: { disableGet: true, disableCreate: true, disableUpdate: true, disableDelete: true }
});

const app = darkchat.app;
const channel = appEventChannel(DARKCHAT_APP);

// ---------------------------------------------------------------------------------------------
// Membership, shared with `DarkchatMessages.ts`
// ---------------------------------------------------------------------------------------------

/**
 * The caller's live member row in a live channel, or null. The membership question. `id` is the
 * row's integer, for the server's own joins and `mine`; `handle` is what a reader may be told.
 */
export const liveMember = async (
  channelId: number,
  citizenid: string
): Promise<{ id: number; alias: string; handle: string } | null> => {
  // The alias and handle are sealed (MICA-432): selected with what they are bound to, opened.
  const found = await Database.single<{
    id: number;
    citizenid: string;
    channel_id: number;
    alias: string;
    handle: string;
  } | null>(
    `SELECT m.\`id\`, m.\`citizenid\`, m.\`channel_id\`, m.\`alias\`, m.\`handle\`
     FROM \`mica_darkchat_members\` m
     JOIN \`${CHANNELS}\` c ON c.\`id\` = m.\`channel_id\` AND c.\`status\` = 'active'
     WHERE m.\`channel_id\` = ? AND m.\`citizenid\` = ? AND m.\`left_at\` IS NULL LIMIT 1`,
    [channelId, citizenid]
  );
  if (!found) return null;
  const row = openRow(MEMBERS, found);
  return { id: Number(row.id), alias: String(row.alias), handle: String(row.handle) };
};

/** One of this file's declared blind indexes; a missing one is a declaration that changed. */
const indexOf = (table: string, column: string): BlindIndex => {
  const entry = blindIndexOf(table, column);
  if (!entry) throw new Error(`[darkchat] ${table}.${column} has no blind index.`);
  return entry;
};

/** `IN (?, …)` for every form a stored index of `value` can take, and the values to bind. */
const indexMatch = async (
  table: string,
  column: string,
  row: object,
  value: string
): Promise<{ sql: string; params: string[] }> => {
  const candidates = await blindIndexCandidates(indexOf(table, column), row, value);
  return { sql: `IN (${candidates.map(() => '?').join(', ')})`, params: candidates };
};

/** Every live member's citizenid, for a push. Never leaves the server. */
export const liveCitizensOf = async (channelId: number): Promise<string[]> => {
  const rows = await Database.query<{ citizenid: string }[]>(
    `SELECT DISTINCT \`citizenid\` FROM \`${MEMBERS}\` WHERE \`channel_id\` = ? AND \`left_at\` IS NULL`,
    [channelId]
  );
  return (rows ?? []).map((row) => String(row.citizenid));
};

/** Whether `alias` is a live member's in this channel, compared as the unique key compares. */
export const aliasIsLive = async (channelId: number, candidate: string): Promise<boolean> => {
  // By the alias's blind index (MICA-432), in every form a stored one can take.
  const match = await indexMatch(MEMBERS, 'alias', { channel_id: channelId }, candidate);
  return Boolean(
    await Database.single<unknown>(
      `SELECT 1 FROM \`${MEMBERS}\` WHERE \`channel_id\` = ? AND \`alias_key\` ${match.sql} LIMIT 1`,
      [channelId, ...match.params]
    )
  );
};

/**
 * The live channel a normalized code opens, by the code's blind index (MICA-432), or null. For a
 * caller that needs the channel and its owner and nothing it shows: `PostToDarkChat`.
 */
export const liveChannelByCode = async (
  code: string
): Promise<{ id: number; citizenid: string } | null> => {
  const match = await indexMatch(CHANNELS, 'code', {}, code);
  const found = await Database.single<{ id: number; citizenid: string } | null>(
    `SELECT \`id\`, \`citizenid\` FROM \`${CHANNELS}\` WHERE \`code_index\` ${match.sql} ` +
      "AND `status` = 'active' LIMIT 1",
    match.params
  );
  return found ? { id: Number(found.id), citizenid: String(found.citizenid) } : null;
};

// ---------------------------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------------------------

/**
 * A code of `CODE_LENGTH` symbols from `CODE_ALPHABET`, uniformly: a byte is kept only below
 * the largest multiple of the alphabet's size, so no symbol is likelier than another.
 */
const drawSymbols = (length: number): string => {
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
};

export const generateCode = (): string => drawSymbols(CODE_LENGTH);

/** A member handle (`HANDLE_LENGTH`), the same way. */
export const generateHandle = (): string => drawSymbols(HANDLE_LENGTH);

/**
 * Letters `utf8mb4_unicode_ci` reads as two, or as a plain one, that Unicode decomposition alone
 * does not take apart. Folded so no alias can sit beside one the old key called the same.
 */
const LETTER_FOLDS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  ı: 'i',
  þ: 'th',
  ħ: 'h',
  ŧ: 't'
};
const FOLDED_LETTER = new RegExp(`[${Object.keys(LETTER_FOLDS).join('')}]`, 'gu');

/**
 * What counts as the same alias in one channel (MICA-432): **at least** everything
 * `alias_key`'s `utf8mb4_unicode_ci` held equal before the alias was sealed, so sealing it gives
 * an impersonator no room the collation did not. Characters the collation ignores dropped
 * (a zero-width space), compatibility forms decomposed (`ｇｈｏｓｔ`), combining marks dropped
 * (`Ghöst`), case folded, the letters above spelled out (`Straße`, `STRASSE`), trailing spaces
 * ignored. Where it folds further than the collation did, two aliases it once let stand side by
 * side are now one — the safe way to differ.
 */
export const aliasKey = (alias: string): string =>
  alias
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .toLowerCase()
    .replace(FOLDED_LETTER, (letter) => LETTER_FOLDS[letter] ?? letter)
    .trimEnd();

/** A code as typed: case-blind, spaces and dashes dropped. Null when it cannot be one. */
export const normalizeCode = (raw: string): string | null => {
  const code = raw.toUpperCase().replace(/[\s-]+/g, '');
  return CODE_SHAPE.test(code) ? code : null;
};

/** Draws before a code collision is treated as something other than bad luck. */
const CODE_ATTEMPTS = 5;

/** Run `write` with fresh codes until one is not taken. */
const withFreshCode = async <T>(write: (code: string) => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    const code = generateCode();
    try {
      return await write(code);
    } catch (error) {
      if (!isDuplicateKey(error) || attempt >= CODE_ATTEMPTS) throw error;
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Failed joins
// ---------------------------------------------------------------------------------------------

/** Ten failed joins in ten minutes, then nothing until the oldest leaves the window. */
export const JOIN_FAILURES = 10;
export const JOIN_WINDOW_MS = 10 * 60_000;

/**
 * Join attempts per **citizenid**, not per source: the stock limiter is keyed on the source,
 * which a reconnect replaces, and a guesser would reconnect. `Privacy.ts` keys its windows the
 * same way for the same reason. In process memory; a restart forgives, which costs a guesser a
 * restart per ten guesses.
 *
 * An attempt is charged **before** the first read, so a burst sent at once cannot all pass the
 * check while every read is still in flight, and refunded once it has proved the code right —
 * a join, or an alias or seat clash, which only a right code reaches. Every other outcome stays
 * charged.
 */
const failedJoins = new Map<string, number[]>();

let now: () => number = () => Date.now();
/** Test seams, matching `__setRateLimitClock` and `__resetRateLimits`. */
export const __setDarkchatClock = (fn?: () => number): void => {
  now = fn ?? (() => Date.now());
};
export const __resetDarkchatJoinLimits = (): void => {
  failedJoins.clear();
};

const recentFailures = (citizenid: string): number[] => {
  const at = now();
  const recent = (failedJoins.get(citizenid) ?? []).filter((t) => at - t < JOIN_WINDOW_MS);
  if (recent.length === 0) failedJoins.delete(citizenid);
  else failedJoins.set(citizenid, recent);
  return recent;
};

/** Charge one attempt; answers the stamp to refund it by. */
const chargeJoin = (citizenid: string): number => {
  const stamp = now();
  failedJoins.set(citizenid, [...recentFailures(citizenid), stamp]);
  return stamp;
};

/** Take back the attempt `stamp` charged: it proved the code right. */
const refundJoin = (citizenid: string, stamp: number): void => {
  const list = failedJoins.get(citizenid);
  if (!list) return;
  const at = list.indexOf(stamp);
  if (at !== -1) list.splice(at, 1);
  if (list.length === 0) failedJoins.delete(citizenid);
};

/** The one answer every failed join gets. Already charged. */
const badCode = (): PlayerFacingError =>
  new PlayerFacingError('That code did not work.', { key: 'server.darkchat.badCode' });

// ---------------------------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------------------------

/** Rounds of `settleOwnership` before it stops; each is a race lost to another leave. */
const SETTLE_ROUNDS = 5;

/**
 * Make the channel's owner a live member, or delete the channel when it has none.
 *
 * Called after every write that can take the owner out — a leave, a removal — and by every one,
 * not only the owner's: an owner leaving at the same moment as the member it would hand over
 * to can hand the channel to somebody who has just left, and whichever of the two settles last
 * sees that and moves it again. Every move is a compare-and-set on the owner it read, so two
 * settles never both win.
 *
 * The heir is the longest-standing live member: the lowest member id. Only the server reads
 * that order; no reader is told an id, and the members list is sorted by alias.
 */
export const settleOwnership = async (channelId: number): Promise<void> => {
  for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
    const owner = await Database.scalar<string | null>(
      `SELECT \`citizenid\` FROM \`${CHANNELS}\` WHERE \`id\` = ? AND \`status\` = 'active'`,
      [channelId]
    );
    if (typeof owner !== 'string') return;
    const ownerLive = await Database.single<unknown>(
      `SELECT 1 FROM \`${MEMBERS}\` WHERE \`channel_id\` = ? AND \`citizenid\` = ? AND \`left_at\` IS NULL LIMIT 1`,
      [channelId, owner]
    );
    if (ownerLive) return;

    const heir = await Database.scalar<string | null>(
      `SELECT \`citizenid\` FROM \`${MEMBERS}\` WHERE \`channel_id\` = ? AND \`left_at\` IS NULL ORDER BY \`id\` LIMIT 1`,
      [channelId]
    );
    if (typeof heir === 'string') {
      await Database.update(
        `UPDATE \`${CHANNELS}\` SET \`citizenid\` = ? WHERE \`id\` = ? AND \`citizenid\` = ? AND \`status\` = 'active'`,
        [heir, channelId, owner]
      );
    } else {
      await Database.update(
        `UPDATE \`${CHANNELS}\` SET \`status\` = 'deleted' WHERE \`id\` = ? AND \`citizenid\` = ? AND \`status\` = 'active'`,
        [channelId, owner]
      );
    }
  }
  console.warn(
    `[darkchat] channel ${channelId}: ownership did not settle; the next leave retries.`
  );
};

/** Is `citizenid` the owner of this live channel? */
const ownsChannel = async (channelId: number, citizenid: string): Promise<boolean> =>
  Boolean(
    await Database.single<unknown>(
      `SELECT 1 FROM \`${CHANNELS}\` WHERE \`id\` = ? AND \`citizenid\` = ? AND \`status\` = 'active' LIMIT 1`,
      [channelId, citizenid]
    )
  );

const notOwner = () =>
  new PlayerFacingError('Only the channel owner can do that.', {
    key: 'server.darkchat.notOwner'
  });

const notMember = () =>
  new PlayerFacingError('You are not in that channel.', { key: 'server.darkchat.notMember' });

const aliasTaken = () =>
  new PlayerFacingError('Somebody in that channel already goes by that alias.', {
    key: 'server.darkchat.aliasTaken'
  });

/** Leave one channel as `citizenid`; true when a live membership ended. */
const leaveChannel = async (channelId: number, citizenid: string): Promise<boolean> => {
  const left = await Database.update(
    `UPDATE \`${MEMBERS}\` SET \`status\` = 'left', \`left_at\` = NOW()
     WHERE \`channel_id\` = ? AND \`citizenid\` = ? AND \`left_at\` IS NULL`,
    [channelId, citizenid]
  );
  if (left) await settleOwnership(channelId);
  return left;
};

/**
 * Insert a member row under a fresh handle, answering a key conflict as what it was: the caller
 * already in the channel, the alias somebody else's, or — neither — a handle already drawn, which
 * draws again. Which key refused is asked of the table, not of the driver's message.
 */
const insertMember = async (
  channelId: number,
  citizenid: string,
  wanted: string
): Promise<{ id: number; handle: string }> => {
  // Asked first as well as by the key (MICA-432): the key compares indexes under one key, and a
  // live alias indexed under an older key or before the first one is the same alias all the same.
  if (await aliasIsLive(channelId, wanted)) throw aliasTaken();
  for (let attempt = 1; ; attempt += 1) {
    const handle = generateHandle();
    try {
      // Sealed to the member and the channel, each with its blind index beside it.
      const place = { channel_id: channelId, citizenid };
      const sealed = await sealRow(MEMBERS, { ...place, alias: wanted, handle });
      const id = await Database.insert(
        'INSERT INTO `mica_darkchat_members` (`channel_id`, `citizenid`, `alias`, `handle`, ' +
          '`alias_index`, `handle_index`) VALUES (?, ?, ?, ?, ?, ?)',
        [
          channelId,
          citizenid,
          sealed.alias,
          sealed.handle,
          await blindIndexFor(indexOf(MEMBERS, 'alias'), place, wanted),
          await blindIndexFor(indexOf(MEMBERS, 'handle'), place, handle)
        ]
      );
      return { id, handle };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      if (await liveMember(channelId, citizenid)) {
        throw new PlayerFacingError('You are already in that channel.', {
          key: 'server.darkchat.alreadyMember'
        });
      }
      if (await aliasIsLive(channelId, wanted)) throw aliasTaken();
      if (attempt >= CODE_ATTEMPTS) throw error;
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

app.registerEvent('create', async (_source, _cbId, data, citizenid) => {
  const name = data.name.trim();
  const as = data.alias.trim();

  // Sealed to the channel (`seal_key`, MICA-432), the code found by its blind index.
  const sealKey = newSealKey();
  const created = await withFreshCode(async (code) => {
    const sealed = await sealRow(CHANNELS, { seal_key: sealKey, name, code });
    return {
      id: await Database.insert(
        'INSERT INTO `mica_darkchat` (`citizenid`, `seal_key`, `name`, `code`, `code_index`) ' +
          'VALUES (?, ?, ?, ?, ?)',
        [
          citizenid,
          sealKey,
          sealed.name,
          sealed.code,
          await blindIndexFor(indexOf(CHANNELS, 'code'), {}, code)
        ]
      ),
      code
    };
  });

  let member: { id: number; handle: string };
  try {
    member = await insertMember(created.id, citizenid, as);
  } catch (error) {
    // A channel nobody is in is one nobody can reach; take it down rather than leave it.
    await Database.update(
      `UPDATE \`${CHANNELS}\` SET \`status\` = 'deleted' WHERE \`id\` = ? AND \`citizenid\` = ?`,
      [created.id, citizenid]
    ).catch(() => false);
    throw error;
  }

  return {
    channel: { id: created.id, name, my_member_id: member.handle, my_alias: as, is_owner: true },
    code: created.code
  };
});

app.registerEvent('join', async (_source, _cbId, data, citizenid) => {
  if (recentFailures(citizenid).length >= JOIN_FAILURES) {
    throw new PlayerFacingError('Too many codes tried. Wait a few minutes and try again.', {
      key: 'server.darkchat.tooManyCodes'
    });
  }
  // Charged now, before the first await, and refunded below only once the code proved right.
  const stamp = chargeJoin(citizenid);

  const code = normalizeCode(data.code);
  if (!code) throw badCode();

  // By the code's blind index (MICA-432), in every form a stored one can take.
  const match = await indexMatch(CHANNELS, 'code', {}, code);
  const sealedFound = await Database.single<{
    id: number;
    seal_key: string;
    name: string;
    code: string;
    is_owner: unknown;
  } | null>(
    `SELECT \`id\`, \`seal_key\`, \`name\`, \`code\`, (\`citizenid\` = ?) AS is_owner
     FROM \`mica_darkchat\` WHERE \`code_index\` ${match.sql} AND \`status\` = 'active' LIMIT 1`,
    [citizenid, ...match.params]
  );
  if (!sealedFound) throw badCode();
  const found = openRow(CHANNELS, sealedFound);
  const id = Number(found.id);

  // Removed is for good, and answered as a code that did not work: the owner's decision is not
  // something to argue with by guessing which of the two it was.
  const removed = await Database.single<unknown>(
    `SELECT 1 FROM \`${MEMBERS}\` WHERE \`channel_id\` = ? AND \`citizenid\` = ? AND \`status\` = 'removed' LIMIT 1`,
    [id, citizenid]
  );
  if (removed) throw badCode();

  // Always a new row, never a reopened one: a rejoin is a new identity, and reopening the old
  // row would move every message it wrote onto whatever alias the rejoin chose.
  let member: { id: number; handle: string };
  try {
    member = await insertMember(id, citizenid, data.alias.trim());
  } catch (error) {
    // An alias or seat clash is reached only with the right code: not a guess.
    if (error instanceof PlayerFacingError) refundJoin(citizenid, stamp);
    throw error;
  }

  /**
   * The last member may have left between the read above and the insert, deleting the channel
   * under it. Asked again now the row exists: a seat in a deleted channel is taken back and
   * answered as any other failed join, never as a success nobody can use.
   */
  const stillLive = await Database.single<unknown>(
    `SELECT 1 FROM \`${CHANNELS}\` WHERE \`id\` = ? AND \`status\` = 'active' LIMIT 1`,
    [id]
  );
  if (!stillLive) {
    await Database.update(
      `UPDATE \`${MEMBERS}\` SET \`status\` = 'left', \`left_at\` = NOW() WHERE \`id\` = ? AND \`left_at\` IS NULL`,
      [member.id]
    );
    throw badCode();
  }
  refundJoin(citizenid, stamp);

  const isOwner = Boolean(Number(found.is_owner));
  const joined: DarkchatJoined = {
    channel: {
      id,
      name: String(found.name),
      my_member_id: member.handle,
      my_alias: data.alias.trim(),
      is_owner: isOwner
    }
  };
  if (isOwner) joined.code = String(found.code);
  return joined;
});

app.registerEvent('list', async (_source, _cbId, _data, citizenid) => {
  // The name is sealed to the channel, the alias and handle to the member (MICA-432): each
  // opened off its own row's columns, none of which leaves this function.
  const rows = await Database.query<
    {
      id: number;
      seal_key: string;
      name: string;
      citizenid: string;
      handle: string;
      alias: string;
      is_owner: unknown;
    }[]
  >(
    `SELECT c.\`id\`, c.\`seal_key\`, c.\`name\`, m.\`citizenid\`, m.\`handle\`, m.\`alias\`,
            (c.\`citizenid\` = m.\`citizenid\`) AS is_owner
     FROM \`mica_darkchat_members\` m
     JOIN \`mica_darkchat\` c ON c.\`id\` = m.\`channel_id\` AND c.\`status\` = 'active'
     WHERE m.\`citizenid\` = ? AND m.\`left_at\` IS NULL
     ORDER BY c.\`id\` DESC`,
    [citizenid]
  );
  return (rows ?? []).map((row): DarkchatChannel => {
    const channelRow = openRow(CHANNELS, { seal_key: row.seal_key, name: row.name });
    const memberRow = openRow(MEMBERS, {
      citizenid: row.citizenid,
      channel_id: row.id,
      alias: row.alias,
      handle: row.handle
    });
    return {
      id: Number(row.id),
      name: String(channelRow.name),
      my_member_id: String(memberRow.handle),
      my_alias: String(memberRow.alias),
      is_owner: Boolean(Number(row.is_owner))
    };
  });
});

/** By alias, not by join order: the order members joined in is not something to hand out. */
app.registerEvent('members', async (_source, _cbId, data, citizenid) => {
  if (!(await liveMember(data.channel_id, citizenid))) throw notMember();
  // Sealed (MICA-432), so opened here and put in alias order here, as `aliasKey` compares —
  // the database can no longer sort what it cannot read. The handle breaks a tie.
  const rows = openRows(
    MEMBERS,
    (await Database.query<
      { citizenid: string; channel_id: number; handle: string; alias: string }[]
    >(
      'SELECT `citizenid`, `channel_id`, `handle`, `alias` FROM `mica_darkchat_members` ' +
        'WHERE `channel_id` = ? AND `left_at` IS NULL',
      [data.channel_id]
    )) ?? []
  );
  return rows
    .map((row): DarkchatMember => ({ id: String(row.handle), alias: String(row.alias) }))
    .toSorted((a, b) => {
      const byAlias = aliasKey(a.alias).localeCompare(aliasKey(b.alias));
      return byAlias !== 0 ? byAlias : a.id.localeCompare(b.id);
    });
});

app.registerEvent('leave', async (_source, _cbId, data, citizenid) => {
  return await leaveChannel(data.channel_id, citizenid);
});

app.registerEvent('code', async (_source, _cbId, data, citizenid) => {
  const row = await Database.single<{ seal_key: string; code: string } | null>(
    'SELECT `seal_key`, `code` FROM `mica_darkchat` ' +
      "WHERE `id` = ? AND `citizenid` = ? AND `status` = 'active'",
    [data.channel_id, citizenid]
  );
  if (!row) throw notOwner();
  return { code: String(openRow(CHANNELS, row).code) };
});

app.registerEvent('rotateCode', async (_source, _cbId, data, citizenid) => {
  // The channel's seal key, to seal the new code to; the owner predicate is the write's.
  const sealKey = await Database.scalar<string | null>(
    'SELECT `seal_key` FROM `mica_darkchat` ' +
      "WHERE `id` = ? AND `citizenid` = ? AND `status` = 'active'",
    [data.channel_id, citizenid]
  );
  if (typeof sealKey !== 'string') throw notOwner();
  return await withFreshCode(async (code) => {
    const sealed = await sealRow(CHANNELS, { seal_key: sealKey, code });
    const moved = await Database.update(
      'UPDATE `mica_darkchat` SET `code` = ?, `code_index` = ? ' +
        "WHERE `id` = ? AND `citizenid` = ? AND `status` = 'active'",
      [
        sealed.code,
        await blindIndexFor(indexOf(CHANNELS, 'code'), {}, code),
        data.channel_id,
        citizenid
      ]
    );
    if (!moved) throw notOwner();
    // That it changed, never what it was (MICA-430): the old code is a credential, not kept.
    await AuditLogger.log({
      citizenid,
      action: 'changed',
      service: 'darkchat',
      method: 'rotateCode',
      targetId: data.channel_id,
      targetTable: CHANNELS,
      details: { what: 'join code' }
    });
    return { code };
  });
});

/**
 * Remove a live member for good, by handle, inside this channel only — a handle from another
 * channel matches nothing here. The owner predicate is in the statement that writes, joined on
 * the channel, so an owner who has just left and handed the channel on cannot land a removal
 * on the way out; and the owner's own row is refused there too, so an owner cannot remove
 * themself into an ownerless channel. They leave instead.
 */
app.registerEvent('removeMember', async (_source, _cbId, data, citizenid) => {
  if (!(await ownsChannel(data.channel_id, citizenid))) throw notOwner();

  // By the handle's blind index (MICA-432), inside this channel only.
  const handle = await indexMatch(MEMBERS, 'handle', {}, data.member_id);
  const target = await Database.scalar<string | null>(
    `SELECT \`citizenid\` FROM \`${MEMBERS}\`
     WHERE \`handle_index\` ${handle.sql} AND \`channel_id\` = ? AND \`left_at\` IS NULL AND \`citizenid\` <> ?`,
    [...handle.params, data.channel_id, citizenid]
  );
  if (typeof target !== 'string') return false;

  const removed = await Database.update(
    `UPDATE \`${MEMBERS}\` m
     JOIN \`${CHANNELS}\` c ON c.\`id\` = m.\`channel_id\` AND c.\`citizenid\` = ? AND c.\`status\` = 'active'
     SET m.\`status\` = 'removed', m.\`left_at\` = NOW()
     WHERE m.\`handle_index\` ${handle.sql} AND m.\`channel_id\` = ? AND m.\`left_at\` IS NULL AND m.\`citizenid\` <> ?`,
    [citizenid, ...handle.params, data.channel_id, citizenid]
  );
  if (!removed) return false;
  await settleOwnership(data.channel_id);

  // So an open app drops the channel. After the write, and never allowed to fail it.
  try {
    channel.push(target, 'removed', { channel_id: data.channel_id });
  } catch (error) {
    console.error('[darkchat] removal push failed for channel', data.channel_id, traceOf(error));
  }
  return true;
});

/**
 * A player's own delete (MICA-168) leaves every channel first, so an owner's channels pass to
 * their heirs rather than staying owned by a citizen whose rows are about to go. Registered,
 * not imported by `Privacy.ts`, for the reason that file gives.
 */
onBeforeSelfServiceDelete('darkchat', async (citizenid) => {
  const rows = await Database.query<{ channel_id: number }[]>(
    `SELECT DISTINCT \`channel_id\` FROM \`${MEMBERS}\` WHERE \`citizenid\` = ? AND \`left_at\` IS NULL`,
    [citizenid]
  );
  for (const row of rows ?? []) await leaveChannel(Number(row.channel_id), citizenid);
});

/**
 * A channel the erased player opened stays live while anyone else is still in it (MICA-428),
 * for the character-deleted purge and the orphan sweep, which run no hook to hand it on.
 */
registerSharedRows(CHANNELS, {
  members: MEMBERS,
  column: 'channel_id',
  owner: 'citizenid',
  leftAt: 'left_at',
  kicked: 'removed'
});

// ---------------------------------------------------------------------------------------------
// The sweep's batching (`sweepDarkchat` in `DarkchatMessages.ts` runs it)
// ---------------------------------------------------------------------------------------------

/** Batches per run: 20,000 rows. A larger backlog drains over the next runs. */
export const SWEEP_MAX_BATCHES = 40;

/** A breath between batches, so player writes into the table run between two updates. */
const SWEEP_YIELD_MS = 50;

const affectedRows = (result: unknown): number => {
  if (result && typeof result === 'object' && 'affectedRows' in result) {
    const value = Number((result as { affectedRows?: unknown }).affectedRows);
    return Number.isFinite(value) ? value : 0;
  }
  return 0;
};

/**
 * Select ids, then move exactly those ids with every condition asked again, in batches of
 * `RETENTION_BATCH`, at most `SWEEP_MAX_BATCHES` of them, with a breath between. Answers the
 * rows moved. The update re-checks, so whatever changed between the two statements wins.
 *
 * Member and channel rows are no longer swept (MICA-428): a `left` or `removed` member and a
 * `deleted` channel are already hidden, and nothing is deleted.
 */
export const updateInBatches = async (
  select: { sql: string; params: readonly unknown[] },
  move: (ids: readonly number[]) => { sql: string; params: readonly unknown[] }
): Promise<number> => {
  let moved = 0;
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch += 1) {
    const rows = await Database.query<{ id: number }[]>(select.sql, [...select.params]);
    const ids = (Array.isArray(rows) ? rows : [])
      .map((row) => Number(row.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0)
      .slice(0, RETENTION_BATCH);
    if (ids.length === 0) break;
    const statement = move(ids);
    moved += affectedRows(await Database.query(statement.sql, [...statement.params]));
    if (ids.length < RETENTION_BATCH) break;
    await new Promise<void>((resolve) => setTimeout(resolve, SWEEP_YIELD_MS));
  }
  return moved;
};
