// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { db } from '../lib/db';
import { assert, callExport, expectOk, seedCitizen, unique, type Outcome } from '../lib/mica';
import { eventually } from '../lib/wait';
import { schemaCreated } from './qbx';

/**
 * A tablet with an identity of its own (MICA-264), as far as a server with nobody connected can
 * show it: the `kind` column micaOS created on a real MariaDB, the tablet switched on by default
 * in the real runtime, and a row written on an offline citizen's behalf landing on a phone of
 * theirs and never on the tablet they also have.
 *
 * **What this cannot reach, and where it can be reached instead.** MICA-264's acceptance — two
 * characters, each with a phone and a tablet, holding disjoint notes and settings, and a tablet
 * request refused for a player holding none, for a phone-only service, and for a device that is
 * not one — is all `mica:server:*` traffic. `ServiceEndpoint` refuses a garbage device and a
 * phone-only service before it looks the player up, but its only answer to either is an
 * `emitNet` to the client that asked, and no client connects to this harness; past that it
 * authenticates through `FrameworkBridge.getPlayer`, which has no player here, and a tablet in a
 * player's inventory needs a player too. `scripts/test-endpoints.js` fires the real handlers for
 * several fake sources against a real MariaDB and captures every `emitNet`, which is exactly
 * what that acceptance needs.
 */

/** A source no player holds. Nobody connects to the harness. */
const ABSENT_SOURCE = 4243;

export const deviceScenarios: Scenario[] = [
  {
    // MICA-264, MICA-306: the first-start bootstrap made `mica_devices.kind` from the
    // declaration, with the default that makes every pre-tablet row a phone without a backfill.
    id: 'devices-phones-kind-column-created-by-first-start',
    mode: 'standalone',
    tickets: ['MICA-264', 'MICA-306'],
    timeoutMs: 45_000,
    run: async (signal) => {
      await schemaCreated(signal);
      const column = await db.row(
        'SELECT `COLUMN_TYPE` AS `type`, `IS_NULLABLE` AS `nullable`, ' +
          '`COLUMN_DEFAULT` AS `fallback` FROM information_schema.COLUMNS ' +
          "WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mica_devices' " +
          "AND `COLUMN_NAME` = 'kind'"
      );
      if (!column) throw new Error('mica_devices has no kind column; the bootstrap left it out');
      assert(
        String(column.type).toLowerCase() === "enum('phone','tablet')",
        `mica_devices.kind is ${String(column.type)}, not enum('phone','tablet')`
      );
      assert(column.nullable === 'NO', 'mica_devices.kind is nullable');
      // MariaDB 10.2.7 and later quote a string default here; older ones do not.
      const fallback = String(column.fallback ?? '').replace(/^'|'$/g, '');
      assert(
        fallback === 'phone',
        `mica_devices.kind defaults to ${String(column.fallback)}, not 'phone'`
      );
    }
  },
  {
    // MICA-264, MICA-263: with `mica_tablet` unset the tablet is on, and has a lock screen, so a
    // tablet-addressed export gets past the device check to the player lookup. Before MICA-264
    // the same calls answered `disabled` (the tablet was off by default) or `unsupported` (it
    // had no lock screen). The real runtime's convar default is what is under test: every unit
    // suite stubs `GetConvar` in JavaScript.
    id: 'devices-tablet-exports-on-by-default-and-lockable',
    mode: 'standalone',
    tickets: ['MICA-264', 'MICA-263'],
    run: async () => {
      const set = GetConvar('mica_tablet', '');
      assert(
        set === '',
        `mica_tablet is '${set}'; this run leaves it unset so the default is what is read`
      );
      const calls: [string, unknown[]][] = [
        ['IsPhoneOpen', [ABSENT_SOURCE, 'tablet']],
        ['SetPhoneEnabled', [ABSENT_SOURCE, false, 'tablet']],
        ['LockPhone', [ABSENT_SOURCE, 'tablet']],
        ['UnlockPhone', [ABSENT_SOURCE, 'tablet']],
        ['IsPhoneLocked', [ABSENT_SOURCE, 'tablet']],
        ['OpenApp', [ABSENT_SOURCE, 'notes', {}, 'tablet']]
      ];
      const wrong: string[] = [];
      for (const [name, args] of calls) {
        const outcome = await callExport<Outcome>(name, ...args);
        if (!outcome || outcome.ok !== false || outcome.reason !== 'unknown_player') {
          wrong.push(`${name}(…, 'tablet') → ${JSON.stringify(outcome)}`);
        }
      }
      // The twin: the device argument is read at all. An export that ignored it would answer
      // `unknown_player` for a device that is not one, too, and pass the loop above.
      for (const name of ['IsPhoneOpen', 'LockPhone', 'IsPhoneLocked']) {
        const bad = await callExport<Outcome>(name, ABSENT_SOURCE, 'watch');
        if (!bad || bad.ok !== false || bad.reason !== 'invalid_args') {
          wrong.push(`${name}(…, 'watch') → ${JSON.stringify(bad)}`);
        }
      }
      if (wrong.length > 0) throw new Error(wrong.join('; '));
    }
  },
  {
    // MICA-264, MICA-282: a notification for an offline citizen lands on a phone of theirs,
    // never on their tablet. The citizen's only device row is an unclaimed tablet, which is
    // both the row they touched last and the one an unfiltered "unclaimed" read would adopt:
    // before MICA-264, `phoneForCitizen` would have put the notification on it. The row is a
    // fixture because nothing but a connected player with a tablet can make micaOS mint one.
    id: 'devices-offline-notification-lands-on-a-phone-never-the-tablet',
    mode: 'standalone',
    tickets: ['MICA-264', 'MICA-282'],
    timeoutMs: 45_000,
    run: async (signal) => {
      await schemaCreated(signal);
      const who = await seedCitizen('two_devices');
      const tabletId = unique('tablet');
      assert(tabletId.length <= 32, `the fixture tablet id ${tabletId} is wider than device_id`);
      await db.insert(
        'INSERT INTO `mica_devices` (`citizenid`, `device_id`, `kind`, `claimed`) ' +
          "VALUES (?, ?, 'tablet', 0)",
        [who.citizenid, tabletId]
      );

      const app = `ext_${GetCurrentResourceName().replace(/[^a-z0-9_]/g, '_')}`;
      const pushed = await expectOk<{ delivered: boolean }>('SendNotification', who.citizenid, {
        app,
        sourceLabel: 'Integration',
        title: 'Which device',
        body: 'offline'
      });
      assert(pushed.delivered === false, 'an offline notification was reported delivered');

      // The positive half: the row exists and names a device at all, so the checks after it are
      // about which device and not about a notification that was never written.
      const deviceId = await eventually(
        async () => {
          const row = await db.row(
            'SELECT `device_id` FROM `mica_notifications` WHERE `citizenid` = ? AND `app` = ?',
            [who.citizenid, app]
          );
          return row?.device_id ? String(row.device_id) : null;
        },
        5_000,
        signal,
        'the persisted notification'
      );
      assert(deviceId !== tabletId, "the offline notification landed on the citizen's tablet");

      const device = await db.row(
        'SELECT `citizenid`, `kind` FROM `mica_devices` WHERE `device_id` = ?',
        [deviceId]
      );
      if (!device) throw new Error(`the notification names phone ${deviceId}, which has no row`);
      assert(device.kind === 'phone', `the notification landed on a ${String(device.kind)}`);
      assert(
        device.citizenid === who.citizenid,
        `the notification landed on ${String(device.citizenid)}'s device`
      );

      // Minting the phone left the tablet as it was: still a tablet, still theirs, not claimed.
      const tablet = await db.row(
        'SELECT `citizenid`, `kind`, `claimed` FROM `mica_devices` WHERE `device_id` = ?',
        [tabletId]
      );
      assert(
        tablet?.kind === 'tablet' &&
          tablet.citizenid === who.citizenid &&
          Number(tablet.claimed) === 0,
        `the tablet row changed: ${JSON.stringify(tablet)}`
      );
      const phones = await db.count(
        "SELECT COUNT(*) FROM `mica_devices` WHERE `citizenid` = ? AND `kind` = 'phone'",
        [who.citizenid]
      );
      assert(phones === 1, `the citizen has ${phones} phone rows, not the one minted for them`);
    }
  }
];
