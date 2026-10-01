// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario, RunSignal } from '../runner';
import { requireTap } from '../lib/console';
import { db } from '../lib/db';
import { HARNESS_KID, assert, harnessKeys, runCommand, seedCitizen } from '../lib/mica';
import { openSealed, sealedKid } from '../lib/sealed';
import { sleep } from '../lib/wait';

/**
 * `micaimport qb-phone` (MICA-233) against a minimal qb-phone schema created for the purpose:
 * the dry run writes nothing, `--apply` brings contacts, a thread and a photo across with the
 * message body sealed (MICA-165), and a second `--apply` writes nothing at all.
 *
 * The source tables are qb-phone's names, which only one qb-phone install can have per database,
 * so they are created fresh here — an existing one fails the scenario rather than being imported
 * — and dropped at the end whatever happened.
 */
const SOURCE_TABLES = ['player_contacts', 'phone_messages', 'phone_gallery'];

interface TableLine {
  table: string;
  read: number;
  written: number;
  skipped: number;
}

const TABLE_LINE =
  /^\[micaimport\] {3}([a-z_#]+): read (\d+), (?:written|would write) (\d+), skipped (\d+)$/;

/**
 * How long a run may take to report. Past micaOS's own 60 s `Database` timeout on purpose: the
 * first hoth run (MICA-302) waited 30 s, saw nothing after the dry run, and stopped before the
 * one line that would have said why — a write that never answered is reported by micaOS only
 * when its 60 s are up.
 */
const REPORT_WAIT_MS = 75_000;

/** Every `[micaimport]` line of the last report, for a reason that says what was skipped. */
let lastReport: string[] = [];

const runImport = async (apply: boolean, signal: RunSignal): Promise<TableLine[]> => {
  const tap = requireTap();
  const mark = tap.mark();
  await runCommand(`micaimport qb-phone${apply ? ' --apply' : ''}`);
  // phone_tweets is the last table the qb-phone importer reports, present or not.
  const last = await tap.waitFor(
    mark,
    /^\[micaimport\] ( {3}phone_tweets: |qb-phone failed part-way|an import is already running)/,
    REPORT_WAIT_MS,
    signal,
    "micaimport's report"
  );
  assert(last.includes('phone_tweets'), last);
  // The `running` flag clears just after the report; never start the next run inside it.
  await sleep(500);
  const lines = tap.since(mark);
  lastReport = lines.filter((line) => line.startsWith('[micaimport]'));
  const header = apply ? '[micaimport] qb-phone — APPLIED' : '[micaimport] qb-phone — dry run';
  assert(
    lines.some((line) => line.startsWith(header)),
    `no '${header}' header in micaimport's report`
  );
  return lines.flatMap((line) => {
    const m = TABLE_LINE.exec(line);
    return m
      ? [{ table: m[1], read: Number(m[2]), written: Number(m[3]), skipped: Number(m[4]) }]
      : [];
  });
};

const tableLine = (lines: TableLine[], table: string): TableLine => {
  const found = lines.find((line) => line.table === table);
  if (!found) throw new Error(`micaimport reported nothing for ${table}`);
  return found;
};

const ledgerRows = async (citizenids: string[]) =>
  await db.rows(
    "SELECT `source_table`, `source_key`, `target_table`, `target_id` FROM `mica_import_ledger` WHERE `source` = 'qb-phone' AND `citizenid` IN (?, ?) ORDER BY `id`",
    citizenids
  );

export const importerScenarios: Scenario[] = [
  {
    id: 'import-qbphone-apply-seals-and-rerun-writes-nothing',
    tickets: ['MICA-233', 'MICA-165'],
    timeoutMs: 200_000,
    run: async (signal) => {
      const alice = await seedCitizen('qb_alice');
      const bob = await seedCitizen('qb_bob');
      const body = `hi from qb ${alice.citizenid}`;
      const created: string[] = [];
      const create = async (table: string, columns: string): Promise<void> => {
        await db.exec(`CREATE TABLE \`${table}\` (${columns})`);
        created.push(table);
      };

      try {
        await create(
          'player_contacts',
          '`id` int NOT NULL AUTO_INCREMENT, ' +
            '`citizenid` varchar(50) DEFAULT NULL, `name` varchar(50) DEFAULT NULL, ' +
            '`number` varchar(50) DEFAULT NULL, PRIMARY KEY (`id`)'
        );
        await create(
          'phone_messages',
          '`id` int NOT NULL AUTO_INCREMENT, `citizenid` varchar(50) DEFAULT NULL, ' +
            '`number` varchar(50) DEFAULT NULL, `messages` text DEFAULT NULL, PRIMARY KEY (`id`)'
        );
        await create(
          'phone_gallery',
          '`citizenid` varchar(255) NOT NULL, `image` varchar(255) NOT NULL, ' +
            '`date` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP'
        );
        await db.insert(
          "INSERT INTO `player_contacts` (`citizenid`, `name`, `number`) VALUES (?, 'Bob Builder', ?)",
          [alice.citizenid, bob.number]
        );
        const history = [
          {
            date: '30-09-2026',
            messages: [
              { message: body, time: '12:30', sender: alice.citizenid, type: 'message', data: {} }
            ]
          }
        ];
        await db.insert(
          'INSERT INTO `phone_messages` (`citizenid`, `number`, `messages`) VALUES (?, ?, ?)',
          [alice.citizenid, bob.number, JSON.stringify(history)]
        );
        await db.exec(
          "INSERT INTO `phone_gallery` (`citizenid`, `image`) VALUES (?, 'https://example.invalid/qb.png')",
          [alice.citizenid]
        );

        const dry = await runImport(false, signal);
        for (const table of SOURCE_TABLES) {
          assert(
            tableLine(dry, table).written >= 1,
            `the dry run would write nothing from ${table}`
          );
        }
        assert(
          (await ledgerRows([alice.citizenid, bob.citizenid])).length === 0,
          'the dry run wrote to the import ledger'
        );
        assert(
          (await db.count('SELECT COUNT(*) FROM `mica_contacts` WHERE `citizenid` = ?', [
            alice.citizenid
          ])) === 0,
          'the dry run wrote a contact'
        );

        const applied = await runImport(true, signal);
        for (const table of SOURCE_TABLES) {
          const line = tableLine(applied, table);
          assert(
            line.written >= 1 && line.skipped === 0,
            `--apply on ${table}: ${JSON.stringify(line)}; micaimport said: ${lastReport.join(' | ')}`
          );
        }

        const contact = await db.row(
          'SELECT `firstname`, `lastname`, `phone` FROM `mica_contacts` WHERE `citizenid` = ?',
          [alice.citizenid]
        );
        assert(
          contact?.firstname === 'Bob' && contact?.phone === bob.number,
          `the imported contact is ${JSON.stringify(contact)}`
        );

        const ledger = await ledgerRows([alice.citizenid, bob.citizenid]);
        const message = ledger.find((row) => row.target_table === 'mica_messages');
        if (!message) throw new Error('the ledger records no imported message');
        assert(
          ledger.some((row) => row.target_table === 'mica_media'),
          'the ledger records no imported photo'
        );
        const row = await db.row(
          'SELECT `citizenid`, `conversation_id`, `message` FROM `mica_messages` WHERE `id` = ?',
          [message.target_id]
        );
        if (!row) throw new Error('the ledger names a message that is not there');
        assert(sealedKid(row.message) === HARNESS_KID, 'the imported body is not sealed');
        const opened = openSealed(row.message, harnessKeys(), {
          table: 'mica_messages',
          column: 'message',
          citizenid: String(row.citizenid),
          scope: [row.conversation_id as number]
        });
        assert(opened === body, 'the imported body opened to something else');
        const members = await db.count(
          'SELECT COUNT(DISTINCT `citizenid`) FROM `mica_messages_participants` WHERE `conversation_id` = ? AND `citizenid` IN (?, ?)',
          [row.conversation_id, alice.citizenid, bob.citizenid]
        );
        assert(members === 2, `the imported thread has ${members} of its two members`);

        const messagesBefore = await db.count(
          'SELECT COUNT(*) FROM `mica_messages` WHERE `conversation_id` = ?',
          [row.conversation_id]
        );
        const again = await runImport(true, signal);
        for (const table of SOURCE_TABLES) {
          const line = tableLine(again, table);
          assert(line.written === 0, `a second --apply wrote ${line.written} from ${table}`);
        }
        assert(
          (await ledgerRows([alice.citizenid, bob.citizenid])).length === ledger.length,
          'a second --apply added to the ledger'
        );
        assert(
          (await db.count('SELECT COUNT(*) FROM `mica_messages` WHERE `conversation_id` = ?', [
            row.conversation_id
          ])) === messagesBefore,
          'a second --apply added messages to the thread'
        );
      } finally {
        // Only what this run created: a table that was already here is not this suite's.
        for (const table of created) {
          await db.exec(`DROP TABLE IF EXISTS \`${table}\``).catch(() => {});
        }
      }
    }
  }
];
