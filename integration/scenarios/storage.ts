// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { requireTap } from '../lib/console';
import { db } from '../lib/db';
import { assert, runCommand, seedCitizen } from '../lib/mica';
import { sleep } from '../lib/wait';

/**
 * `micastorage` from the console, against the real schema through real oxmysql: the one place
 * its two statements meet `information_schema` as MariaDB fills it and a `UNION ALL` over every
 * table micaOS created, rather than a `Database` stub's idea of either.
 *
 * Written out here rather than imported, so a change to what an owner reads fails this file.
 */
const HEADER =
  "[micastorage] mica_ tables, largest first. Sizes are InnoDB's estimates; row counts are exact.";
const HEADER_LINE =
  /^\[micastorage\] mica_ tables, largest first\. Sizes are InnoDB's estimates; row counts are exact\.$/;
const TABLE_LINE =
  /^\[micastorage\] {3}(mica_[A-Za-z0-9_$]+): (\d+(?:\.\d)?)(B|KB|MB|GB) .*; (.*)$/;
const TOTAL_LINE = /^\[micastorage\] total: (\d+) table\(s\), .*; (\d+) row\(s\): /;
const PLAIN_ROWS = /^(\d+) row\(s\), no status column$/;
const STATUS_ROWS = /^(\d+) row\(s\): (\d+) active, (\d+) inactive/;

const UNIT = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as const;

export const storageScenarios: Scenario[] = [
  {
    // Every mica_ base table gets one line, largest first, between the header and a total that
    // adds them up; a table without a status (the ledger) is a plain count that matches the
    // table; and a citizen with a row in a counted table is nowhere in what it printed.
    id: 'storage-micastorage-reports-every-table-and-names-no-player',
    mode: 'standalone',
    tickets: [],
    timeoutMs: 30_000,
    run: async (signal) => {
      const tap = requireTap();
      const citizen = await seedCitizen('storage');

      const mark = tap.mark();
      await runCommand('micastorage');
      await tap.waitFor(mark, HEADER_LINE, 20_000, signal, "micastorage's header");
      await tap.waitFor(mark, TOTAL_LINE, 20_000, signal, "micastorage's total line");
      // The lines are printed in one loop; a moment covers a listener that delivers late.
      await sleep(500);

      const said = tap.since(mark).filter((line) => line.startsWith('[micastorage]'));
      const busy = said.find((line) => / already running|failed|could not count/.test(line));
      if (busy) throw new Error(`micastorage: ${busy}`);
      assert(said[0] === HEADER, `the first line was '${said[0]}', not the header`);

      const lines = said.slice(1, -1);
      const total = TOTAL_LINE.exec(said.at(-1) ?? '');
      if (!total) throw new Error(`the last line was '${said.at(-1)}', not the total`);

      const printed = lines.map((line) => {
        const match = TABLE_LINE.exec(line);
        if (!match) throw new Error(`not a table line: '${line}'`);
        return {
          name: match[1],
          bytes: Number(match[2]) * UNIT[match[3] as keyof typeof UNIT],
          rows: match[4]
        };
      });

      // One line for every mica_ base table the database holds, and for nothing else.
      const live = (
        await db.rows(
          'SELECT TABLE_NAME AS `name` FROM information_schema.TABLES ' +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' " +
            "AND TABLE_NAME LIKE 'mica|_%' ESCAPE '|'"
        )
      )
        .map((row) => String(row.name))
        .sort();
      const names = printed.map((p) => p.name).sort();
      assert(live.length > 40, `information_schema answered only ${live.length} mica_ tables`);
      if (JSON.stringify(names) !== JSON.stringify(live)) {
        const missing = live.filter((n) => !names.includes(n));
        const extra = names.filter((n) => !live.includes(n));
        throw new Error(
          `printed tables differ: missing ${missing.join(', ')}; extra ${extra.join(', ')}`
        );
      }

      // Largest first, as printed.
      for (let i = 1; i < printed.length; i++) {
        assert(
          printed[i].bytes <= printed[i - 1].bytes,
          `${printed[i].name} printed after the smaller ${printed[i - 1].name}`
        );
      }

      // The total adds up the lines it closes.
      let rows = 0;
      for (const p of printed) {
        const counted = PLAIN_ROWS.exec(p.rows) ?? STATUS_ROWS.exec(p.rows);
        if (!counted) throw new Error(`${p.name}: rows read '${p.rows}'`);
        rows += Number(counted[1]);
      }
      assert(Number(total[1]) === printed.length, `the total names ${total[1]} tables`);
      assert(
        Number(total[2]) === rows,
        `the total says ${total[2]} rows; the lines add to ${rows}`
      );

      // The ledger has no status: a plain count, and the right one.
      const ledger = printed.find((p) => p.name === 'mica_schema_migrations');
      const ledgerRows = await db.count('SELECT COUNT(*) FROM `mica_schema_migrations`');
      assert(
        ledger?.rows === `${ledgerRows} row(s), no status column`,
        `mica_schema_migrations read '${ledger?.rows}', expected ${ledgerRows} plain rows`
      );

      // A status table: split into active and the rest, and holding the fixture's active row.
      const numbers = printed.find((p) => p.name === 'mica_phone_numbers');
      const split = STATUS_ROWS.exec(numbers?.rows ?? '');
      assert(split !== null, `mica_phone_numbers read '${numbers?.rows}', not a status split`);
      assert(
        Number(split?.[2]) >= 1,
        'mica_phone_numbers counted no active row beside the fixture'
      );
      assert(
        Number(split?.[1]) === Number(split?.[2]) + Number(split?.[3]),
        `mica_phone_numbers: '${numbers?.rows}' does not add up`
      );

      // Nobody is named. The positive twin is everything above: the lines were read and checked.
      const leaked = said.filter(
        (line) => line.includes(citizen.citizenid) || line.includes(citizen.number)
      );
      assert(leaked.length === 0, `micastorage printed the fixture citizen: ${leaked.join(' | ')}`);
    }
  }
];
