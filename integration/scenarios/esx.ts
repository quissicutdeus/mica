// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { bootOrphanSweepEnded } from '../lib/bootSweep';
import { requireTap } from '../lib/console';
import { db } from '../lib/db';
import { ESX_SEED } from '../lib/esxSeed';
import { serverWho } from '../lib/logToken';
import { assert, expectOk, expectRefusal, unique } from '../lib/mica';
import { eventually } from '../lib/wait';
import { callOn, phoneItem, phoneItemExistsInOxInventory } from '../lib/oxInventory';
import { schemaCreated } from './qbx';
import { BOOTSTRAP_REFUSED } from './schema';

/**
 * micaOS beside es_extended and ox_inventory (MICA-304), with no player connected.
 *
 * Only the esx run starts this stack: the box's wrapper loads oxmysql, ox_lib, esx_lib,
 * es_extended, ox_inventory, mica and this suite, in that order, with `inventory:framework esx`,
 * no `mica_standalone`, `mica_phone_item "phone"`, and ESX Legacy's own `legacy.sql` imported
 * (plus one `users` row, `ESX_SEED`) before FXServer starts. es_extended turns itself onto
 * ox_inventory (`Config.CustomInventory = "ox"`) when ox_inventory's folder is there, and
 * ox_inventory's esx bridge raises a script error if it did not, so a stack that starts is
 * already some proof of both.
 *
 * What none of them can reach is what the qbx run cannot either: a connected player.
 * `FrameworkBridge.getPlayer`, a usable item actually used, an online job and the item count
 * the phone's gate asks all need one. micaOS reads and writes no item metadata since MICA-438.
 *
 * What the console proves instead is in the wrapper, which holds the whole console to the line
 * this resource starts too late to hear: micaOS's bridge line for es_extended. The schema line
 * is the one standalone prints too (ESX and standalone share a width), so on its own it says
 * nothing about the framework; the bridge line and `esx-stack-loaded-...` below do.
 */

const STACK = ['oxmysql', 'ox_lib', 'esx_lib', 'es_extended', 'ox_inventory', 'mica'] as const;

type Fn = (...args: unknown[]) => unknown;

/** `exports.es_extended.getSharedObject()`: the table micaOS's own bridge reads, as it reads it. */
const sharedObject = async (): Promise<Record<string, Fn>> => {
  const shared = await callOn<Record<string, Fn> | null>('es_extended', 'getSharedObject');
  if (!shared || typeof shared !== 'object') {
    throw new Error('es_extended.getSharedObject() answered no table');
  }
  return shared;
};

const call = async <T>(shared: Record<string, Fn>, name: string, ...args: unknown[]) => {
  const fn = shared[name];
  if (typeof fn !== 'function') throw new Error(`the ESX shared object has no ${name}()`);
  return (await fn(...args)) as T;
};

export const esxScenarios: Scenario[] = [
  {
    // MICA-197, MICA-227: the stack the other scenarios stand on is really the one running,
    // es_extended is on ox_inventory, and micaOS was not asked to be standalone beside it.
    id: 'esx-stack-loaded-and-micaos-not-standalone',
    mode: 'esx',
    tickets: ['MICA-304', 'MICA-197'],
    run: async () => {
      for (const name of STACK) {
        const state = GetResourceState(name);
        assert(state === 'started', `${name} is ${state}, not started`);
      }
      const standalone = GetConvar('mica_standalone', '');
      assert(standalone === '', `mica_standalone is '${standalone}'; the esx run leaves it unset`);
      assert(
        GetConvar('inventory:framework', '') === 'esx',
        "inventory:framework is not 'esx', so ox_inventory is not on the esx bridge"
      );
      // What ox_inventory's esx bridge checks and errors on, read the way it reads it.
      const esx = await sharedObject();
      const inventory = await call<unknown>(esx, 'GetConfig', 'CustomInventory');
      assert(
        inventory === 'ox',
        `es_extended's CustomInventory is ${JSON.stringify(inventory)}, not "ox"`
      );
      // The two calls `esxAdapter.detect()` and `getAllPlayers` make. With no player, the honest
      // answers are "none": `GetExtendedPlayers` is an empty list, and nobody is on source 4242.
      const online = await call<unknown>(esx, 'GetExtendedPlayers');
      const count = Array.isArray(online)
        ? online.length
        : Object.keys((online as object | null) ?? {}).length;
      assert(count === 0, 'es_extended lists an online player in a run where nobody connected');
      const player = await call<unknown>(esx, 'GetPlayerFromId', 4242);
      assert(player === null || player === undefined, 'es_extended has a player on source 4242');
    }
  },
  {
    // MICA-229, MICA-280: micaOS registered the phone as a usable item with es_extended, which
    // is what `FrameworkBridge.registerUsableItem` does at import. Read back through
    // es_extended's own `GetUsableItems`, since nothing of micaOS's says so.
    id: 'esx-phone-item-registered-as-usable-in-es-extended',
    mode: 'esx',
    tickets: ['MICA-304', 'MICA-229', 'MICA-280'],
    run: async () => {
      const item = phoneItem();
      const usable =
        (await call<Record<string, unknown> | null>(await sharedObject(), 'GetUsableItems')) ?? {};
      assert(
        usable[item] === true,
        `es_extended has no use callback for '${item}'; micaOS registered none`
      );
      // The control: a name nobody registered is not in the list, so the answer above is a
      // registration and not a list that holds everything.
      assert(
        usable[unique('not-an-item')] === undefined,
        'es_extended lists a use callback for an item nobody registered'
      );
    }
  },
  {
    // MICA-279, MICA-280: the item micaOS gates the phone on exists in ox_inventory's own item
    // list, so a player can hold one at all.
    id: 'esx-phone-item-exists-in-ox-inventory',
    mode: 'esx',
    tickets: ['MICA-304', 'MICA-279', 'MICA-280'],
    timeoutMs: 40_000,
    run: phoneItemExistsInOxInventory
  },
  {
    // MICA-223, MICA-225, MICA-232: a character micaOS has never heard of, known only to ESX's
    // own `users` row, resolves with nobody connected. The row is the wrapper's seed and
    // `ESX_SEED` is its shape. What the bridge promises is what is asserted, and no more: ESX's
    // core `users` has no phone, so a number is found through whichever column `users` carries
    // (`phone_number`, in legacy.sql), and an identifier alone resolves the character but
    // answers no number, since micaOS issues none on ESX.
    id: 'esx-offline-lookup-reads-the-users-row',
    mode: 'esx',
    tickets: ['MICA-304', 'MICA-223', 'MICA-225', 'MICA-232'],
    timeoutMs: 45_000,
    run: async (signal) => {
      // The lookups below read `mica_phone_numbers` beside `users`, which the first start may
      // not have made yet.
      await schemaCreated(signal);
      const row = await db.row(
        'SELECT `identifier`, `firstname`, `lastname`, `phone_number` FROM `users` ' +
          'WHERE `identifier` = ?',
        [ESX_SEED.identifier]
      );
      if (!row) {
        throw new Error(
          `users holds no ${ESX_SEED.identifier}: the wrapper seeds it after importing ` +
            'legacy.sql, and the wrapper on the box predates MICA-304'
        );
      }
      assert(
        row.firstname === ESX_SEED.firstname && row.lastname === ESX_SEED.lastname,
        `the seeded user is named ${String(row.firstname)} ${String(row.lastname)}`
      );
      assert(
        row.phone_number === ESX_SEED.phone,
        `the seeded users.phone_number is ${String(row.phone_number)}`
      );

      // No number of micaOS's own for this character: any answer comes from ESX's row.
      const issued = await db.count(
        'SELECT COUNT(*) FROM `mica_phone_numbers` WHERE `citizenid` = ?',
        [ESX_SEED.identifier]
      );
      assert(issued === 0, `micaOS already issued ${ESX_SEED.identifier} ${issued} number(s)`);

      assert(
        (await expectOk<string>('GetCitizenId', ESX_SEED.phone)) === ESX_SEED.identifier,
        'GetCitizenId did not answer the identifier holding the number in users.phone_number'
      );
      // The probe that found the column says so once, on the first lookup by number.
      await requireTap().waitFor(
        0,
        /es_extended: offline lookup by phone number reads `users\.phone_number`/,
        5_000,
        signal,
        "micaOS's line naming the users column it reads a phone number from"
      );
      // The character is found by identifier and has no number to give: `not_ready`, where a
      // character ESX does not have is `unknown_player`. The first is what proves `users` was
      // read, and the second that the read is not an answer to everything.
      await expectRefusal('not_ready', 'GetPhoneNumber', ESX_SEED.identifier);
      await expectRefusal('unknown_player', 'GetPhoneNumber', unique('nobody'));
      await expectRefusal('unknown_player', 'GetCitizenId', '5559999999');
    }
  },
  {
    // MICA-306, MICA-289: micaOS created its schema on this database's first start, at the
    // width ESX's `users.identifier` needs (60), beside the `users` table the wrapper imported
    // from legacy.sql. micaOS creates no foreign key onto `users`, so the width is the only
    // thing the framework decided.
    id: 'esx-schema-bootstrapped-at-esx-width',
    mode: 'esx',
    tickets: ['MICA-304', 'MICA-306', 'MICA-289'],
    timeoutMs: 45_000,
    run: async (signal) => {
      const mode = GetConvar('mica_integration_schema', '');
      assert(
        mode === 'bootstrap',
        `mica_integration_schema is '${mode}', not 'bootstrap': this run was not set up to start ` +
          'micaOS on a database holding ESX and nothing of its own'
      );
      await schemaCreated(signal);

      const types = (
        await db.rows(
          'SELECT DISTINCT `COLUMN_TYPE` AS `type` FROM information_schema.COLUMNS ' +
            "WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` LIKE 'mica\\_%' " +
            "AND `COLUMN_NAME` = 'citizenid'"
        )
      ).map((r) => String(r.type));
      assert(
        types.length === 1 && types[0] === 'varchar(60)',
        `the citizenid columns are ${types.join(', ')}; ESX's users.identifier takes varchar(60)`
      );
      const audit = await db.row(
        'SELECT `COLUMN_TYPE` AS `type` FROM information_schema.COLUMNS ' +
          "WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mica_audit_logs' " +
          "AND `COLUMN_NAME` = 'citizenid'"
      );
      assert(
        audit?.type === 'varchar(60)',
        `mica_audit_logs.citizenid is ${String(audit?.type)}, not varchar(60)`
      );
      // ESX's table, which micaOS reads and never creates, is the one that was there, and it is
      // the width the columns above were sized for.
      const identifier = await db.row(
        'SELECT `COLUMN_TYPE` AS `type` FROM information_schema.COLUMNS ' +
          "WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'users' " +
          "AND `COLUMN_NAME` = 'identifier'"
      );
      assert(
        identifier?.type === 'varchar(60)',
        `users.identifier is ${String(identifier?.type)}, not varchar(60)`
      );
      const owner = await db.count('SELECT COUNT(*) FROM `users` WHERE `identifier` = ?', [
        ESX_SEED.identifier
      ]);
      assert(owner === 1, 'the ESX users table lost the seeded row');

      const refused = requireTap()
        .since(0)
        .filter((line) => BOOTSTRAP_REFUSED.test(line));
      if (refused.length > 0) {
        throw new Error(`micaOS refused to create the schema: ${refused.join(' | ')}`);
      }
    }
  },
  {
    // MICA-440: esx_multicharacter hands a deleted character's `char<slot>:` identifier to the
    // next character created in the slot, and on ESX the identifier is the citizenid. That
    // character used to resolve to the deleted one's phone, which the purge kept live and this
    // process kept cached, with its passcode on the lock screen. With nobody connected, an
    // offline notification resolves the citizen's phone (`phoneForCitizen`), before the delete
    // and after it, in the same micaOS process; one sent while the character does not exist
    // creates no phone at all. The battery needs a connected player, and ESX keeps the number on
    // the character: `scripts/test-schema.js` covers the battery on each shape, the number on qb.
    id: 'esx-character-recreated-in-its-slot-gets-a-new-phone',
    mode: 'esx',
    tickets: ['MICA-440', 'MICA-438', 'MICA-428'],
    timeoutMs: 60_000,
    run: async (signal) => {
      await schemaCreated(signal);
      // Nothing is planted while the start-up sweep runs: with the `users` row gone it would
      // erase the character's rows itself, before this scenario's own delete.
      await bootOrphanSweepEnded(requireTap(), 10_000, signal);
      const tap = requireTap();
      const identifier = `char1:${unique('slot')}`;
      const digits = (n: number): string =>
        String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
      const ssn = (): string => `9${digits(2)}-${digits(2)}-${digits(4)}`;
      assert(identifier.length <= 60, `the fixture identifier ${identifier} is wider than ESX's`);
      const app = `ext_${GetCurrentResourceName().replace(/[^a-z0-9_]/g, '_')}`;
      /**
       * A `users` row as the box's wrapper seeds `ESX_SEED`'s (`mica-smoke-release.sh`): every
       * column legacy.sql gives no default, `ssn` among them, NOT NULL and unique, so each
       * character takes one of its own in the seed's shape and never the seed's `555-…`.
       */
      // `exec`, not `insert`: `users` is keyed by its identifier, so there is no insert id.
      const character = (lastname: string) =>
        db.exec(
          'INSERT INTO `users` (`identifier`, `ssn`, `accounts`, `group`, `inventory`, `job`, ' +
            '`job_grade`, `loadout`, `metadata`, `position`, `firstname`, `lastname`, ' +
            '`dateofbirth`, `sex`, `height`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            identifier,
            ssn(),
            JSON.stringify({ money: 0, bank: 0, black_money: 0 }),
            'user',
            '[]',
            'unemployed',
            0,
            '[]',
            '{}',
            JSON.stringify({ x: 0.0, y: 0.0, z: 0.0, heading: 0.0 }),
            'Slot',
            lastname,
            '01/01/1990',
            'f',
            170
          ]
        );
      /** The phone an offline notification of this `kind` landed on, once it is written. */
      const notifiedPhone = async (kind: string, citizenid = identifier): Promise<string> => {
        const pushed = await expectOk<{ delivered: boolean }>('SendNotification', citizenid, {
          app,
          kind,
          sourceLabel: 'Integration',
          title: 'Which phone',
          body: 'offline'
        });
        assert(pushed.delivered === false, 'an offline notification was reported delivered');
        return await eventually(
          async () => {
            const row = await db.row(
              'SELECT `device_id` FROM `mica_notifications` WHERE `citizenid` = ? AND `kind` = ?',
              [citizenid, kind]
            );
            return row?.device_id ? String(row.device_id) : null;
          },
          5_000,
          signal,
          `the ${kind} notification`
        );
      };
      const statusOf = async (table: string, deviceId: string): Promise<string[]> =>
        (
          await db.rows(`SELECT \`status\` FROM \`${table}\` WHERE \`device_id\` = ?`, [deviceId])
        ).map((row) => String(row.status));

      const passcode = (citizenid: string, deviceId: string) =>
        db.insert(
          'INSERT INTO `mica_lockscreen` (`citizenid`, `device_id`, `passcode_hash`, `passcode_salt`) ' +
            'VALUES (?, ?, ?, ?)',
          [citizenid, deviceId, 'f'.repeat(64), 'e'.repeat(32)]
        );

      /**
       * A character who lives on, with the same micaOS rows as the one deleted below: whether a
       * phone may be created asks the orphan sweep's verdict, whose identity check samples
       * micaOS's own owners and needs one of them in `users`. On a fresh database the deleted
       * character's would be the only ones, a server the sweep refuses (`identity-mismatch`),
       * and the create would go ahead and say so rather than be refused.
       */
      await passcode(ESX_SEED.identifier, await notifiedPhone('mica440_seed', ESX_SEED.identifier));

      await character('Old');
      const oldPhone = await notifiedPhone('mica440_before');
      await passcode(identifier, oldPhone);

      // The character is deleted: es_extended's row goes, and the owner's hook fires.
      await db.exec('DELETE FROM `users` WHERE `identifier` = ?', [identifier]);
      const token = await serverWho(identifier);
      const mark = tap.mark();
      emit('mica:server:shell:characterDeleted', identifier);
      const said = await tap.waitFor(
        mark,
        new RegExp(
          `^\\[mica\\] (erased \\d+ row\\(s\\) for deleted character|purge for) .*${token}`
        ),
        30_000,
        signal,
        "the purge's summary"
      );
      assert(said.startsWith('[mica] erased'), said);
      for (const table of ['mica_devices', 'mica_lockscreen']) {
        const status = await statusOf(table, oldPhone);
        assert(
          status.length === 1 && status[0] === 'erased',
          `the deleted character's ${table} row is ${JSON.stringify(status)}, not erased`
        );
      }

      // While the character does not exist, a write on their behalf creates no phone for them:
      // the notification is dropped, said with their token, and nothing lands.
      const gone = tap.mark();
      const refused = await expectOk<{ delivered: boolean }>('SendNotification', identifier, {
        app,
        kind: 'mica440_gone',
        sourceLabel: 'Integration',
        title: 'Nobody',
        body: 'offline'
      });
      assert(refused.delivered === false, 'a notification to nobody was reported delivered');
      await tap.waitFor(
        gone,
        new RegExp(`^\\[mica\\] no phone to notify ${token} on; dropping the row`),
        10_000,
        signal,
        'the dropped notification for a character who does not exist'
      );
      const live = await db.count(
        "SELECT COUNT(*) FROM `mica_devices` WHERE `citizenid` = ? AND `status` = 'active'",
        [identifier]
      );
      assert(live === 0, `a character who does not exist was given ${live} live phone(s)`);

      // A new character in the same slot: the same identifier, in the same micaOS process.
      await character('New');
      const newPhone = await notifiedPhone('mica440_after');
      assert(newPhone !== oldPhone, "the new character's notification landed on the old phone");
      const phones = await db.rows(
        'SELECT `device_id`, `kind`, `status` FROM `mica_devices` WHERE `citizenid` = ? ORDER BY `id`',
        [identifier]
      );
      assert(
        JSON.stringify(phones.map((row) => [row.device_id, row.kind, row.status])) ===
          JSON.stringify([
            [oldPhone, 'phone', 'erased'],
            [newPhone, 'phone', 'active']
          ]),
        `the identifier's device rows are ${JSON.stringify(phones)}`
      );
      const locks = await db.count(
        "SELECT COUNT(*) FROM `mica_lockscreen` WHERE `citizenid` = ? AND `status` = 'active'",
        [identifier]
      );
      assert(locks === 0, `the new character has ${locks} live lock-screen row(s), not none`);
      // The positive twin of the refusal above: the same write, once the character exists.
      const dropped = await db.count(
        'SELECT COUNT(*) FROM `mica_notifications` WHERE `citizenid` = ? AND `kind` = ?',
        [identifier, 'mica440_gone']
      );
      assert(dropped === 0, 'the notification sent while nobody existed was written after all');
    }
  }
];
