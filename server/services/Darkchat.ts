// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from 'node:crypto';
import { PlayerFacingError } from '../lib/errors';
import { defineService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { appEventChannel } from '../lib/appEvents';
import { isDuplicateKey } from '../lib/sqlErrors';
import { RETENTION_BATCH } from '../lib/contentRetention';
import { onBeforeSelfServiceDelete } from './Privacy';
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
  schema: {
    name: { type: 'string', length: CHANNEL_NAME_MAX, notNull: true, clientWritable: false },
    /**
     * The join code. Private, and never returned except by `create` and `code`/`rotateCode`,
     * which only the owner reaches. Unique forever, deleted channels included — see below.
     */
    code: {
      type: 'string',
      length: CODE_LENGTH,
      notNull: true,
      clientWritable: false,
      private: true
    }
  },
  indexes: [{ name: 'code', columns: ['code'], unique: true }],
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
        alias: { type: 'string', length: ALIAS_MAX, notNull: true },
        /** The handle readers know this member by (`HANDLE_LENGTH`). Drawn, never chosen. */
        handle: { type: 'string', length: HANDLE_LENGTH, notNull: true },
        /**
         * `active` while live; `left` by the member's own leave; `removed` by the owner, which
         * also refuses every later join by the same citizen.
         */
        status: {
          type: 'enum',
          values: ['active', 'left', 'removed'],
          notNull: true,
          default: 'active'
        },
        /** Membership is live while this is NULL (`liveWhileNull`). Set by leave and remove. */
        left_at: { type: 'timestamp' },
        created_at: { type: 'timestamp', notNull: true, defaultNow: true },
        /**
         * `alias` while the member is live, NULL after. Carries the unique key that makes an
         * alias one person's among a channel's live members, collation and all: `Ghost` and
         * `ghost` are the same alias, which is the point when the alias is the only name.
         */
        alias_key: {
          type: 'string',
          length: ALIAS_MAX,
          generatedAs: 'CASE WHEN `left_at` IS NULL THEN `alias` ELSE NULL END'
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
        { name: 'handle', columns: ['handle'], unique: true },
        { name: 'citizenid', columns: ['citizenid'] },
        /** The sweep's walk over rows whose member has gone. */
        { name: 'status_left_at', columns: ['status', 'left_at'] }
      ],
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
  const row = await Database.single<{ id: number; alias: string; handle: string } | null>(
    `SELECT m.\`id\`, m.\`alias\`, m.\`handle\` FROM \`${MEMBERS}\` m
     JOIN \`${CHANNELS}\` c ON c.\`id\` = m.\`channel_id\` AND c.\`status\` = 'active'
     WHERE m.\`channel_id\` = ? AND m.\`citizenid\` = ? AND m.\`left_at\` IS NULL LIMIT 1`,
    [channelId, citizenid]
  );
  return row ? { id: Number(row.id), alias: String(row.alias), handle: String(row.handle) } : null;
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
export const aliasIsLive = async (channelId: number, candidate: string): Promise<boolean> =>
  Boolean(
    await Database.single<unknown>(
      `SELECT 1 FROM \`${MEMBERS}\` WHERE \`channel_id\` = ? AND \`alias_key\` = ? LIMIT 1`,
      [channelId, candidate]
    )
  );

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
  for (let attempt = 1; ; attempt += 1) {
    const handle = generateHandle();
    try {
      const id = await Database.insert(
        `INSERT INTO \`${MEMBERS}\` (\`channel_id\`, \`citizenid\`, \`alias\`, \`handle\`) VALUES (?, ?, ?, ?)`,
        [channelId, citizenid, wanted, handle]
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

  const created = await withFreshCode(async (code) => ({
    id: await Database.insert(
      `INSERT INTO \`${CHANNELS}\` (\`citizenid\`, \`name\`, \`code\`) VALUES (?, ?, ?)`,
      [citizenid, name, code]
    ),
    code
  }));

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

  const found = await Database.single<{ id: number; name: string; is_owner: unknown } | null>(
    `SELECT \`id\`, \`name\`, (\`citizenid\` = ?) AS is_owner FROM \`${CHANNELS}\`
     WHERE \`code\` = ? AND \`status\` = 'active' LIMIT 1`,
    [citizenid, code]
  );
  if (!found) throw badCode();
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
  if (isOwner) {
    const own = await Database.scalar<string | null>(
      `SELECT \`code\` FROM \`${CHANNELS}\` WHERE \`id\` = ? AND \`citizenid\` = ?`,
      [id, citizenid]
    );
    if (typeof own === 'string') joined.code = own;
  }
  return joined;
});

app.registerEvent('list', async (_source, _cbId, _data, citizenid) => {
  const rows = await Database.query<
    { id: number; name: string; my_member_id: string; my_alias: string; is_owner: unknown }[]
  >(
    `SELECT c.\`id\`, c.\`name\`, m.\`handle\` AS my_member_id, m.\`alias\` AS my_alias,
            (c.\`citizenid\` = m.\`citizenid\`) AS is_owner
     FROM \`${MEMBERS}\` m
     JOIN \`${CHANNELS}\` c ON c.\`id\` = m.\`channel_id\` AND c.\`status\` = 'active'
     WHERE m.\`citizenid\` = ? AND m.\`left_at\` IS NULL
     ORDER BY c.\`id\` DESC`,
    [citizenid]
  );
  return (rows ?? []).map((row): DarkchatChannel => ({
    id: Number(row.id),
    name: String(row.name),
    my_member_id: String(row.my_member_id),
    my_alias: String(row.my_alias),
    is_owner: Boolean(Number(row.is_owner))
  }));
});

/** By alias, not by join order: the order members joined in is not something to hand out. */
app.registerEvent('members', async (_source, _cbId, data, citizenid) => {
  if (!(await liveMember(data.channel_id, citizenid))) throw notMember();
  const rows = await Database.query<{ handle: string; alias: string }[]>(
    `SELECT \`handle\`, \`alias\` FROM \`${MEMBERS}\`
     WHERE \`channel_id\` = ? AND \`left_at\` IS NULL ORDER BY \`alias\``,
    [data.channel_id]
  );
  return (rows ?? []).map((row): DarkchatMember => ({
    id: String(row.handle),
    alias: String(row.alias)
  }));
});

app.registerEvent('leave', async (_source, _cbId, data, citizenid) => {
  return await leaveChannel(data.channel_id, citizenid);
});

app.registerEvent('code', async (_source, _cbId, data, citizenid) => {
  const code = await Database.scalar<string | null>(
    `SELECT \`code\` FROM \`${CHANNELS}\` WHERE \`id\` = ? AND \`citizenid\` = ? AND \`status\` = 'active'`,
    [data.channel_id, citizenid]
  );
  if (typeof code !== 'string') throw notOwner();
  return { code };
});

app.registerEvent('rotateCode', async (_source, _cbId, data, citizenid) => {
  return await withFreshCode(async (code) => {
    const moved = await Database.update(
      `UPDATE \`${CHANNELS}\` SET \`code\` = ? WHERE \`id\` = ? AND \`citizenid\` = ? AND \`status\` = 'active'`,
      [code, data.channel_id, citizenid]
    );
    if (!moved) throw notOwner();
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

  const target = await Database.scalar<string | null>(
    `SELECT \`citizenid\` FROM \`${MEMBERS}\`
     WHERE \`handle\` = ? AND \`channel_id\` = ? AND \`left_at\` IS NULL AND \`citizenid\` <> ?`,
    [data.member_id, data.channel_id, citizenid]
  );
  if (typeof target !== 'string') return false;

  const removed = await Database.update(
    `UPDATE \`${MEMBERS}\` m
     JOIN \`${CHANNELS}\` c ON c.\`id\` = m.\`channel_id\` AND c.\`citizenid\` = ? AND c.\`status\` = 'active'
     SET m.\`status\` = 'removed', m.\`left_at\` = NOW()
     WHERE m.\`handle\` = ? AND m.\`channel_id\` = ? AND m.\`left_at\` IS NULL AND m.\`citizenid\` <> ?`,
    [citizenid, data.member_id, data.channel_id, citizenid]
  );
  if (!removed) return false;
  await settleOwnership(data.channel_id);

  // So an open app drops the channel. After the write, and never allowed to fail it.
  try {
    channel.push(target, 'removed', { channel_id: data.channel_id });
  } catch (error) {
    console.error('[darkchat] removal push failed for channel', data.channel_id, error);
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

// ---------------------------------------------------------------------------------------------
// The sweep's member and channel half (`sweepDarkchat` in `DarkchatMessages.ts` runs it)
// ---------------------------------------------------------------------------------------------

/** Batches per table per run: 20,000 rows. A larger backlog drains over the next runs. */
export const SWEEP_MAX_BATCHES = 40;

/** A breath between batches, so player writes into the table run between two deletes. */
const SWEEP_YIELD_MS = 50;

const affectedRows = (result: unknown): number => {
  if (result && typeof result === 'object' && 'affectedRows' in result) {
    const value = Number((result as { affectedRows?: unknown }).affectedRows);
    return Number.isFinite(value) ? value : 0;
  }
  return 0;
};

/**
 * Select ids, then delete exactly those ids with every condition asked again, in batches of
 * `RETENTION_BATCH`, at most `SWEEP_MAX_BATCHES` of them, with a breath between. Answers the
 * rows removed. The delete re-checks, so whatever changed between the two statements wins.
 */
export const deleteInBatches = async (
  select: { sql: string; params: readonly unknown[] },
  remove: (ids: readonly number[]) => { sql: string; params: readonly unknown[] }
): Promise<number> => {
  let removed = 0;
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch += 1) {
    const rows = await Database.query<{ id: number }[]>(select.sql, [...select.params]);
    const ids = (Array.isArray(rows) ? rows : [])
      .map((row) => Number(row.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0)
      .slice(0, RETENTION_BATCH);
    if (ids.length === 0) break;
    const statement = remove(ids);
    removed += affectedRows(await Database.query(statement.sql, [...statement.params]));
    if (ids.length < RETENTION_BATCH) break;
    await new Promise<void>((resolve) => setTimeout(resolve, SWEEP_YIELD_MS));
  }
  return removed;
};

const marks = (ids: readonly number[]): string => ids.map(() => '?').join(', ');

/**
 * Forget who stood behind an alias once nothing needs it, run after the messages half so the
 * rows it frees are already gone. Children before parents, and nothing taken by cascade:
 *
 * - **A `left` member row** whose `left_at` is past the window and that no message row still
 *   names. A reported message the hold kept keeps its author row, and with it the alias staff
 *   read. Its messages were all written before it left, so they are past the window too.
 * - **A `removed` member row only once its channel is deleted.** In a live channel it is what
 *   refuses the removed citizen's rejoin, so it stays; in a deleted one it refuses nothing.
 * - **A deleted channel** with no member row and no message row left, so the delete cascades
 *   into nothing a hold kept.
 */
export const sweepMembersAndChannels = async (
  hours: number
): Promise<{ members: number; channels: number }> => {
  const unreferenced = (row: string) =>
    `NOT EXISTS (SELECT 1 FROM \`mica_darkchat_messages\` x WHERE x.\`author_member_id\` = ${row}.\`id\`)`;
  const gone = (row: string) =>
    `${row}.\`left_at\` < NOW() - INTERVAL ? HOUR AND ${unreferenced(row)} AND (${row}.\`status\` = 'left' OR (${row}.\`status\` = 'removed' AND EXISTS (SELECT 1 FROM \`${CHANNELS}\` c WHERE c.\`id\` = ${row}.\`channel_id\` AND c.\`status\` = 'deleted')))`;

  const members = await deleteInBatches(
    {
      sql: `SELECT m.\`id\` FROM \`${MEMBERS}\` m WHERE ${gone('m')} ORDER BY m.\`left_at\`, m.\`id\` LIMIT ${RETENTION_BATCH}`,
      params: [hours]
    },
    (ids) => ({
      sql: `DELETE FROM \`${MEMBERS}\` WHERE \`id\` IN (${marks(ids)}) AND ${gone(`\`${MEMBERS}\``)} LIMIT ${RETENTION_BATCH}`,
      params: [...ids, hours]
    })
  );

  const empty = (row: string) =>
    `${row}.\`status\` = 'deleted' ` +
    `AND NOT EXISTS (SELECT 1 FROM \`${MEMBERS}\` m WHERE m.\`channel_id\` = ${row}.\`id\`) ` +
    `AND NOT EXISTS (SELECT 1 FROM \`mica_darkchat_messages\` x WHERE x.\`channel_id\` = ${row}.\`id\`)`;
  const channels = await deleteInBatches(
    {
      sql: `SELECT c.\`id\` FROM \`${CHANNELS}\` c WHERE ${empty('c')} ORDER BY c.\`id\` LIMIT ${RETENTION_BATCH}`,
      params: []
    },
    (ids) => ({
      sql: `DELETE FROM \`${CHANNELS}\` WHERE \`id\` IN (${marks(ids)}) AND ${empty(`\`${CHANNELS}\``)} LIMIT ${RETENTION_BATCH}`,
      params: [...ids]
    })
  );
  return { members, channels };
};
