// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { requireTap } from '../lib/console';
import { db } from '../lib/db';
import { assert, expectOk, expectRefusal, unique } from '../lib/mica';
import {
  callOn,
  itemMetadataRoundTripsThroughAStash,
  phoneItem,
  phoneItemExistsInOxInventory
} from '../lib/oxInventory';
import { QBX_SEED } from '../lib/qbxSeed';
import { eventually } from '../lib/wait';
import { BOOTSTRAP_REFUSED } from './schema';

/**
 * micaOS beside qbx_core and ox_inventory (MICA-304), with no player connected.
 *
 * Only the qbx run starts this stack: the box's wrapper loads oxmysql, ox_lib, qbx_core,
 * ox_inventory, mica and this suite, in that order, with `inventory:framework qbx`, no
 * `mica_standalone`, `mica_phone_item "phone"`, and qbx_core's own `qbx_core.sql` imported
 * (plus one `players` row, `QBX_SEED`) before FXServer starts. These scenarios are what that
 * stack lets a server prove without a client.
 *
 * What none of them can reach: a connected player. `FrameworkBridge.getPlayer`, a usable item
 * actually used, an online job or charinfo write-back, and micaOS's own item-metadata seam
 * (`framework/itemMetadata.ts`), which is keyed by a player's source and is not an export, all
 * need one. The metadata scenario below therefore holds ox_inventory's half of that seam, the
 * exact export shapes it reads, and says so.
 *
 * What the console proves instead is in the wrapper, which holds the whole console to two
 * lines this resource starts too late to hear: micaOS's bridge line for qbx_core and its
 * first-start schema line for qbx/qb.
 */

/**
 * Waits for micaOS's first-start schema, as `schema-created-by-first-start-without-import` does:
 * the migrations ledger's seed is the bootstrap's last statement, so a ledger with rows is a
 * create that reached its end. Until then a `mica_` table may not exist, which is not an answer.
 * Bounded, and the failure says what never happened. Every qbx scenario that reads or writes a
 * `mica_` table (or calls an export that does) starts with this. The runner does not gate for
 * them, so a scenario that touches no micaOS table is not held up by a schema it does not use.
 */
export const schemaCreated = (signal: { readonly aborted: boolean }): Promise<number> =>
  eventually(
    async () => {
      try {
        const rows = await db.count('SELECT COUNT(*) FROM `mica_schema_migrations`');
        return rows > 0 ? rows : null;
      } catch {
        return null;
      }
    },
    30_000,
    signal,
    "micaOS's first-start bootstrap to seed the migrations ledger"
  );

const STACK = ['oxmysql', 'ox_lib', 'qbx_core', 'ox_inventory', 'mica'] as const;

export const qbxScenarios: Scenario[] = [
  {
    // MICA-197, MICA-227: the stack the other scenarios stand on is really the one running,
    // and micaOS was not asked to be standalone beside it.
    id: 'qbx-stack-loaded-and-micaos-not-standalone',
    mode: 'qbx',
    tickets: ['MICA-304', 'MICA-197'],
    run: async () => {
      for (const name of STACK) {
        const state = GetResourceState(name);
        assert(state === 'started', `${name} is ${state}, not started`);
      }
      // `mica_standalone` beside a framework is the conflict micaOS reports and then resolves
      // in the framework's favour; the wrapper must not have set it for this run.
      const standalone = GetConvar('mica_standalone', '');
      assert(standalone === '', `mica_standalone is '${standalone}'; the qbx run leaves it unset`);
      assert(
        GetConvar('inventory:framework', '') === 'qbx',
        "inventory:framework is not 'qbx', so ox_inventory is not on the qbx bridge"
      );
      // The two exports `qbxAdapter.detect()` and `getAllPlayers` probe. With no player, the
      // honest answers are "none".
      const player = await callOn('qbx_core', 'GetPlayer', 4242);
      assert(player === null || player === undefined, 'qbx_core has a player on source 4242');
      const online = await callOn<Record<string, unknown> | null>('qbx_core', 'GetQBPlayers');
      assert(
        online === null || online === undefined || Object.keys(online).length === 0,
        'qbx_core lists an online player in a run where nobody connected'
      );
    }
  },
  {
    // MICA-229, MICA-280: micaOS registered the phone as a usable item with qbx_core, which is
    // what `FrameworkBridge.registerUsableItem` does at import. Read back through qbx_core's own
    // export, since nothing of micaOS's says so.
    id: 'qbx-phone-item-registered-as-usable-in-qbx-core',
    mode: 'qbx',
    tickets: ['MICA-304', 'MICA-229', 'MICA-280'],
    run: async () => {
      const item = phoneItem();
      const registered = await callOn('qbx_core', 'CanUseItem', item);
      assert(
        Boolean(registered),
        `qbx_core has no use callback for '${item}'; micaOS registered none`
      );
      // The control: a name nobody registered answers nothing, so the answer above is a
      // registration and not an export that says yes to everything.
      const nobody = await callOn('qbx_core', 'CanUseItem', unique('not-an-item'));
      assert(!nobody, 'qbx_core answers a use callback for an item nobody registered');
    }
  },
  {
    // MICA-279, MICA-280: the item micaOS gates the phone on exists in ox_inventory's own item
    // list, so a player can hold one at all.
    id: 'qbx-phone-item-exists-in-ox-inventory',
    mode: 'qbx',
    tickets: ['MICA-304', 'MICA-279', 'MICA-280'],
    timeoutMs: 40_000,
    run: phoneItemExistsInOxInventory
  },
  {
    // MICA-279, MICA-280, MICA-219: per-item metadata through a stash, in the shapes
    // `readItemSlots` and `writeItemMetadata` read and write. This is ox_inventory's half of
    // that seam, not micaOS's (see the file header): `GetSlotsWithItem` answers `{ slot,
    // metadata }` for each copy, and `SetMetadata` replaces the whole table, which is why
    // micaOS merges before it writes.
    id: 'qbx-item-metadata-round-trips-through-a-stash',
    mode: 'qbx',
    tickets: ['MICA-304', 'MICA-279', 'MICA-280', 'MICA-219'],
    timeoutMs: 40_000,
    run: itemMetadataRoundTripsThroughAStash
  },
  {
    // MICA-223, MICA-232, MICA-284: a character micaOS has never heard of, known only to qbx's
    // own `players` row, resolves both ways with nobody connected. The row is the wrapper's seed
    // and `QBX_SEED` is its shape. The phone is in `charinfo` alone, so this is the offline
    // `players` read and not micaOS's own number table.
    id: 'qbx-offline-lookup-reads-the-players-row',
    mode: 'qbx',
    tickets: ['MICA-304', 'MICA-223', 'MICA-232', 'MICA-284'],
    timeoutMs: 45_000,
    run: async (signal) => {
      // The lookups below read `mica_phone_numbers`, which the first start may not have made yet.
      await schemaCreated(signal);
      const row = await db.row(
        'SELECT `citizenid`, `charinfo` FROM `players` WHERE `citizenid` = ?',
        [QBX_SEED.citizenid]
      );
      if (!row) {
        throw new Error(
          `players holds no ${QBX_SEED.citizenid}: the wrapper seeds it after importing ` +
            'qbx_core.sql, and the wrapper on the box predates MICA-304'
        );
      }
      const charinfo = JSON.parse(String(row.charinfo)) as Record<string, unknown>;
      assert(
        charinfo.firstname === QBX_SEED.firstname && charinfo.lastname === QBX_SEED.lastname,
        `the seeded charinfo names ${String(charinfo.firstname)} ${String(charinfo.lastname)}`
      );
      assert(
        charinfo.phone === QBX_SEED.phone,
        `the seeded charinfo phone is ${String(charinfo.phone)}`
      );

      // No number of micaOS's own for this character: any answer comes from qbx's row.
      const issued = await db.count(
        'SELECT COUNT(*) FROM `mica_phone_numbers` WHERE `citizenid` = ?',
        [QBX_SEED.citizenid]
      );
      assert(issued === 0, `micaOS already issued ${QBX_SEED.citizenid} ${issued} number(s)`);

      assert(
        (await expectOk<string>('GetPhoneNumber', QBX_SEED.citizenid)) === QBX_SEED.phone,
        'GetPhoneNumber did not answer the number in charinfo'
      );
      assert(
        (await expectOk<string>('GetCitizenId', QBX_SEED.phone)) === QBX_SEED.citizenid,
        'GetCitizenId did not answer the character holding the number in charinfo'
      );
      // The same lookups refuse a character qbx does not have.
      await expectRefusal('unknown_player', 'GetPhoneNumber', unique('nobody'));
      await expectRefusal('unknown_player', 'GetCitizenId', '5559999999');
    }
  },
  {
    // MICA-306, MICA-289: micaOS created its schema on this database's first start, sized by
    // qbx_core's `players(citizenid)` (50 wide), against the table the wrapper imported from
    // qbx_core.sql. The wrapper holds the console to the line that says it did.
    id: 'qbx-schema-bootstrapped-at-qb-width',
    mode: 'qbx',
    tickets: ['MICA-304', 'MICA-306', 'MICA-289'],
    timeoutMs: 45_000,
    run: async (signal) => {
      const mode = GetConvar('mica_integration_schema', '');
      assert(
        mode === 'bootstrap',
        `mica_integration_schema is '${mode}', not 'bootstrap': this run was not set up to start ` +
          'micaOS on a database holding qbx_core and nothing of its own'
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
        types.length === 1 && types[0] === 'varchar(50)',
        `the citizenid columns are ${types.join(', ')}; qbx_core's players takes varchar(50)`
      );
      const audit = await db.row(
        'SELECT `COLUMN_TYPE` AS `type` FROM information_schema.COLUMNS ' +
          "WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mica_audit_logs' " +
          "AND `COLUMN_NAME` = 'citizenid'"
      );
      assert(
        audit?.type === 'varchar(50)',
        `mica_audit_logs.citizenid is ${String(audit?.type)}, not varchar(50)`
      );
      // qbx_core's table, which micaOS reads and never creates, is the one that was there.
      const owner = await db.count('SELECT COUNT(*) FROM `players` WHERE `citizenid` = ?', [
        QBX_SEED.citizenid
      ]);
      assert(owner === 1, 'the qbx_core players table lost the seeded row');

      const refused = requireTap()
        .since(0)
        .filter((line) => BOOTSTRAP_REFUSED.test(line));
      if (refused.length > 0) {
        throw new Error(`micaOS refused to create the schema: ${refused.join(' | ')}`);
      }
    }
  }
];
