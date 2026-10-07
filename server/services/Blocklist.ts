// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineService, SchemaRepository } from '../lib/defineService';
import { Database } from '../lib/Database';
import { phoneNumberFrom } from '../lib/netGuard';

/**
 * Numbers a player has blocked (MICA-64).
 *
 * Server-enforced in two places, not just here: `Phone.ts`'s `start` handler refuses a
 * call from a blocked number before it ever rings, and `Messages.ts`'s
 * `deliverToParticipants` skips the live push to a recipient who has blocked the sender —
 * a client-side-only block is theatre, since a modified client can already emit
 * `mica:server:phone:start`/`mica:server:messages:send` directly (§2.9).
 *
 * Owner-scoped generic CRUD, the same shape as any other small player-owned list
 * (Contacts, Notes): `get` lists a player's own blocked numbers, `create` adds one,
 * `delete` removes one. `update` is off — replacing a blocked number in place is not a
 * real action; block a different number and unblock the old one instead.
 */
export interface BlockedNumber {
  id: number;
  citizenid: string;
  /** The phone the block was made on (MICA-282). */
  phone_id?: string | null;
  number: string;
  status?: 'active' | 'deleted';
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * Blocking a number this phone once blocked and then unblocked brings that row back (MICA-318).
 *
 * `delete` is soft, so an unblocked row keeps its `(phone_id, number)` and still holds
 * `phone_number_unique`: a plain insert for the same pair is a duplicate-key error, which
 * reached the player as the generic failure. A partial unique index would need MariaDB to
 * have one, and hard-deleting would break the rule `Repository.delete` keeps for every table.
 *
 * So `create` first looks for this citizen's own deleted row for the pair and re-activates
 * it, refreshing `created_at` as a new block would set it; only when there is none does it
 * insert. Both statements name the `citizenid` and the `phone_id` (§2.9): another owner's row
 * under the same key is never revived — that insert still fails on the key, as before.
 *
 * The comparison is SQL's, under the column's collation, so it matches the pair the unique
 * key compares; the revive also requires the citizen, which `handOver` has already moved to
 * the phone's holder by the time a block runs (`transferPhoneRows`). A double tap that races the revive falls through to the
 * insert and is refused by the key, the same answer a double tap on a new number gets.
 */
class BlocklistRepository extends SchemaRepository<BlockedNumber> {
  override async create(data: Partial<BlockedNumber>): Promise<number> {
    const { citizenid, phone_id: phoneId, number } = data;
    if (citizenid && phoneId && typeof number === 'string') {
      const id = await Database.scalar<number | null>(
        `SELECT \`id\` FROM \`${this.tableName}\` ` +
          "WHERE `citizenid` = ? AND `phone_id` = ? AND `number` = ? AND `status` = 'deleted' " +
          'LIMIT 1',
        [citizenid, phoneId, number]
      );
      if (id !== null && id !== undefined) {
        const revived = await Database.update(
          `UPDATE \`${this.tableName}\` ` +
            "SET `status` = 'active', `created_at` = CURRENT_TIMESTAMP " +
            "WHERE `id` = ? AND `citizenid` = ? AND `phone_id` = ? AND `status` = 'deleted'",
          [id, citizenid, phoneId]
        );
        if (revived) return Number(id);
      }
    }
    return await super.create(data);
  }
}

export const blocklist = defineService<BlockedNumber>({
  id: 'blocklist',
  deviceOwned: true,
  access: { read: 'owner', write: 'owner' },
  schema: {
    number: { type: 'string', length: 32, notNull: true, clientFilterable: true }
  },
  // One row per (blocking phone, blocked number) — enforced by the database rather than a
  // find-then-insert a double-tap on "Block" could race. Per phone since MICA-282
  // (`0002_phone_data_follows_the_phone` swaps the old `citizenid_number_unique` for it);
  // the *enforcement* in `isBlocked`/`blockedBy` stays by citizen — see their notes.
  indexes: [{ name: 'phone_number_unique', columns: ['phone_id', 'number'], unique: true }],
  options: { disableUpdate: true },
  repositoryFactory: (resolved) => new BlocklistRepository(resolved)
});

/**
 * Whether `citizenid` has blocked `number` — on any phone they hold.
 *
 * The rows are device-owned (MICA-282) and each phone shows and edits its own list, but the
 * *enforcement* is by citizen: a number blocked on any phone a player holds is blocked for
 * that player. The alternative — enforcing per phone — needs the callee's phone resolved
 * from the dialled number on every call and every delivery, for a distinction (a number
 * blocked on my burner still ringing my main phone) nobody has asked for. Since a stolen
 * phone's rows move to its holder, this stays consistent with the model either way.
 *
 * A plain exported function rather than a raw table read from `Phone.ts`/`Messages.ts` —
 * both need this question answered and neither owns `mica_blocklist`, the same reason
 * `Signal.ts` exports `isConnected` instead of every caller querying its own state
 * directly. `number` is normalised through `phoneNumberFrom` first: a caller here is
 * always passing a phone number already resolved server-side (the dialer's own number,
 * a message sender's own number), never a raw client payload, but bounding it the same
 * way it was validated on the way in keeps this function safe to call with anything.
 */
export const isBlocked = async (citizenid: string, number: string): Promise<boolean> => {
  const target = phoneNumberFrom(number);
  if (!target) return false;

  const row = await Database.scalar<number | null>(
    `SELECT 1 FROM \`mica_blocklist\` WHERE \`citizenid\` = ? AND \`number\` = ? AND \`status\` = 'active' LIMIT 1`,
    [citizenid, target]
  );
  return Boolean(row);
};

/**
 * Which of these people have blocked this number — one query, however many of them there are.
 *
 * `Messages.deliverToParticipants` asked `isBlocked` once per recipient, so a group send was
 * one round trip per person on top of everything else it was doing per person (MICA-197).
 * The question is the same one `isBlocked` answers and the predicate is the same; only the
 * `citizenid` side is widened from `=` to `IN`.
 *
 * Returns the set that *has* blocked, rather than a per-citizenid map, because every caller
 * asks "may I push to this one" and a set answers that with a membership test. An empty set
 * is the ordinary case and costs no query at all.
 *
 * The citizenids are bound parameters and the list is deduplicated first, so a repeated entry
 * cannot widen the statement (§2.9). The number goes through `phoneNumberFrom` exactly as
 * `isBlocked`'s does.
 */
export const blockedBy = async (
  citizenids: readonly string[],
  number: string
): Promise<Set<string>> => {
  const blocked = new Set<string>();

  const target = phoneNumberFrom(number);
  if (!target) return blocked;

  const wanted = [...new Set(citizenids.filter(Boolean))];
  if (wanted.length === 0) return blocked;

  const placeholders = wanted.map(() => '?').join(', ');
  const rows = await Database.query<{ citizenid: string }[]>(
    `SELECT \`citizenid\` FROM \`mica_blocklist\`
     WHERE \`citizenid\` IN (${placeholders}) AND \`number\` = ? AND \`status\` = 'active'`,
    [...wanted, target]
  );

  for (const row of rows) if (row?.citizenid) blocked.add(row.citizenid);
  return blocked;
};
