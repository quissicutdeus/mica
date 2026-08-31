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
 * `gphone:server:phone:start`/`gphone:server:messages:send` directly (§2.9).
 *
 * Owner-scoped generic CRUD, the same shape as any other small player-owned list
 * (Contacts, Notes): `get` lists a player's own blocked numbers, `create` adds one,
 * `delete` removes one. `update` is off — replacing a blocked number in place is not a
 * real action; block a different number and unblock the old one instead.
 */
export interface BlockedNumber {
  id: number;
  citizenid: string;
  number: string;
  status?: 'active' | 'deleted';
  created_at: Date | string;
  updated_at: Date | string;
}

export const blocklist = defineService<BlockedNumber>({
  id: 'blocklist',
  access: { read: 'owner', write: 'owner' },
  schema: {
    number: { type: 'string', length: 32, notNull: true, clientFilterable: true }
  },
  // One row per (blocker, blocked number) — enforced by the database rather than a
  // find-then-insert a double-tap on "Block" could race.
  indexes: [{ name: 'citizenid_number_unique', columns: ['citizenid', 'number'], unique: true }],
  options: { disableUpdate: true }
});

/**
 * Whether `citizenid` has blocked `number`.
 *
 * A plain exported function rather than a raw table read from `Phone.ts`/`Messages.ts` —
 * both need this question answered and neither owns `gphone_blocklist`, the same reason
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
    `SELECT 1 FROM \`gphone_blocklist\` WHERE \`citizenid\` = ? AND \`number\` = ? AND \`status\` = 'active' LIMIT 1`,
    [citizenid, target]
  );
  return Boolean(row);
};
