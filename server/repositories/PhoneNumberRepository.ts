// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from '../lib/Database';
import { SchemaRepository } from '../lib/defineService';
import type { PhoneNumberRow } from '../lib/phoneNumbers';

/**
 * The two writes a phone number needs that no ownership predicate can express (MICA-284).
 *
 * `Repository.update` scopes every write by the citizenid in the `WHERE`, and that is the
 * right shape for a player editing their own row. Neither write below is only that: both move a
 * row's *device*. Attaching a legacy number puts it on its owner's phone; detaching a row that
 * names somebody else takes it off a phone that is not theirs.
 *
 * So both are **named methods on the repository**, which is what §2.9 asks of a privileged
 * write, rather than a service-level bypass. Neither is reachable from a client: the service
 * declares `write: 'server'`, so no net event exists for this table at all, and the only
 * caller is `syncNumber`, which takes the phone id from the citizen's own `mica_devices` row
 * and the citizenid from the framework connection — never from a payload.
 * `reachability.test.ts` keeps the first half of that honest and `phoneNumbers.test.ts` the
 * second.
 *
 * **Neither writes a version** (MICA-438 review). A version keeps content somebody chose to
 * replace (MICA-430); a row gaining or losing its phone replaces no content, and the number on
 * it stays as it was. Plain updates, each scoped by every column that has to be true for it to
 * be the write intended, so a row that moved meanwhile is left alone and the caller reads it
 * again. Nothing writes the `'handover'` version reason any more; the value stays in the frozen
 * `mica_versions.reason` ENUM.
 */
export class PhoneNumberRepository extends SchemaRepository<PhoneNumberRow> {
  /**
   * Put a citizen's legacy number onto their phone: only a row of theirs that is on no phone
   * yet. Unversioned, so it works on any schema with `device_id` on this table (0001 added it as
   * `phone_id`, 0008 named it), whether `micaschema apply` has caught up with MICA-430 or not.
   *
   * Throws the driver's duplicate-entry error if the phone already carries a number — two
   * syncs racing for the same phone — because `device_id_unique` is the authority on that and
   * the caller reads the winner back rather than pre-checking (see `numberForPhone`).
   */
  async attachToPhone(rowId: number, deviceId: string, citizenid: string): Promise<boolean> {
    return await Database.update(
      `UPDATE \`${this.tableName}\` SET \`device_id\` = ? ` +
        'WHERE `id` = ? AND `citizenid` = ? AND `device_id` IS NULL',
      [deviceId, rowId, citizenid]
    );
  }

  /**
   * Take a number row off a phone when it names somebody other than `owner`, the phone's owner
   * (MICA-438 review). Only a handover before MICA-436 could leave one, where it ran — no live
   * server did. The row cannot tell which character should have had the number, so this adopts
   * nothing: the number stays with the character the row names, as their legacy number, and the
   * phone's owner goes on to their own (`detachForeign` in the service has the two cases).
   * Nothing writes such a row now; this only takes one off the phone.
   *
   * Scoped by the row, the phone, and the citizen it must *not* name, so it touches nothing
   * but a stray row on the phone the caller resolved as `owner`'s own.
   */
  async detachForeign(rowId: number, deviceId: string, owner: string): Promise<boolean> {
    return await Database.update(
      `UPDATE \`${this.tableName}\` SET \`device_id\` = NULL ` +
        'WHERE `id` = ? AND `device_id` = ? AND `citizenid` <> ?',
      [rowId, deviceId, owner]
    );
  }
}
