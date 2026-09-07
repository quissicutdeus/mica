// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SchemaRepository } from '../lib/defineService';
import type { PhoneNumberRow } from '../lib/phoneNumbers';

/**
 * The two writes a phone number needs that no ownership predicate can express (MICA-284).
 *
 * `Repository.update` scopes every write by the citizenid in the `WHERE`, and that is the
 * right shape for a player editing their own row. Neither write below is that. Attaching a
 * legacy number to the phone its owner is using changes which *device* a row belongs to,
 * and moving a number to whoever is now holding that phone changes which *citizen* it
 * belongs to — the old owner's citizenid is the one thing the predicate could name, and the
 * whole point of the write is that it is no longer theirs.
 *
 * So both are **named methods on the repository built over `protected updateUnscoped`**,
 * which is exactly what §2.9 asks of a privileged write, rather than a service-level bypass.
 * Neither is reachable from a client: the service declares `write: 'server'`, so no net event
 * exists for this table at all, and the only caller is `syncNumber`, which resolves the phone
 * id from the item in the player's own inventory and the citizenid from the framework
 * connection — never from a payload. `reachability.test.ts` keeps the first half of that
 * honest and `phoneNumbers.test.ts` the second.
 */
export class PhoneNumberRepository extends SchemaRepository<PhoneNumberRow> {
  /**
   * Put a citizen's legacy number onto the phone they are using.
   *
   * Throws the driver's duplicate-entry error if the phone already carries a number — two
   * syncs racing for the same phone — because `phone_id_unique` is the authority on that and
   * the caller reads the winner back rather than pre-checking (see `numberForPhone`).
   */
  async attachToPhone(rowId: number, phoneId: string): Promise<boolean> {
    return await this.updateUnscoped(rowId, { phone_id: phoneId });
  }

  /**
   * The phone changed hands: the number on it now belongs to whoever is holding it.
   *
   * This is the write that makes "steal a phone, steal the number" true, and the reason the
   * row keeps a `citizenid` at all after MICA-284 — `getPlayerByPhone`, `readCitizenIdByNumber`
   * and every offline lookup resolve a number through it.
   */
  async transferToHolder(rowId: number, citizenid: string): Promise<boolean> {
    return await this.updateUnscoped(rowId, { citizenid });
  }
}
