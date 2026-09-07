// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineService } from '../lib/defineService';
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
  options: { disableUpdate: true }
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
