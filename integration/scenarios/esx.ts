// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { requireTap } from '../lib/console';
import { db } from '../lib/db';
import { ESX_SEED } from '../lib/esxSeed';
import { assert, expectOk, expectRefusal, unique } from '../lib/mica';
import {
  callOn,
  itemMetadataRoundTripsThroughAStash,
  phoneItem,
  phoneItemExistsInOxInventory
} from '../lib/oxInventory';
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
 * `FrameworkBridge.getPlayer`, a usable item actually used, an online job and micaOS's own
 * item-metadata seam all need one, so the metadata scenario holds ox_inventory's half of that
 * seam and says so (see `lib/oxInventory.ts`).
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
    // MICA-279, MICA-280, MICA-219: per-item metadata through a stash, ox_inventory's half of
    // the seam micaOS reads and writes (see `lib/oxInventory.ts`).
    id: 'esx-item-metadata-round-trips-through-a-stash',
    mode: 'esx',
    tickets: ['MICA-304', 'MICA-279', 'MICA-280', 'MICA-219'],
    timeoutMs: 40_000,
    run: itemMetadataRoundTripsThroughAStash
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
  }
];
