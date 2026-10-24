// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { requireTap } from '../lib/console';
import { db } from '../lib/db';
import { serverWho } from '../lib/logToken';
import { assert, unique } from '../lib/mica';
import { runMediaPrune } from '../lib/mediaPrune';
import { sleep } from '../lib/wait';

/**
 * Age-based retention (MICA-167) and the character-deleted purge (MICA-168, MICA-300), on
 * fixture rows, through the two doors a server owner has: `micamedia prune` from the console and
 * the `mica:server:shell:characterDeleted` event another server resource fires.
 *
 * Since MICA-428 neither deletes: retention moves a row to `expired`, the purge to `erased`, and
 * every row stays. So each check reads a row's status, and every row is still there.
 */

const RETENTION_CONVAR = 'mica_media_retention';

/**
 * The window this scenario prunes under, in days. Shorter than the default (365) on purpose:
 * the marker micaOS wrote at start announces the default window, and a marker for a longer
 * window never covers a shorter one, so this window's grace is the fixture marker's alone.
 */
const WINDOW_DAYS = 2;
const MARKER = `retention:mica_media:${WINDOW_DAYS}d`;

const mediaRow = async (citizenid: string, ageDays: number): Promise<number> =>
  await db.insert(
    'INSERT INTO `mica_media` (`citizenid`, `kind`, `url`, `created_at`, `updated_at`) ' +
      "VALUES (?, 'link', 'https://example.invalid/retention.png', " +
      'NOW() - INTERVAL ? DAY, NOW() - INTERVAL ? DAY)',
    [citizenid, ageDays, ageDays]
  );

/** A row's status, or null when the row is gone — which nothing may make it since MICA-428. */
const statusOf = async (table: string, id: number): Promise<string | null> => {
  const row = await db.row(`SELECT \`status\` FROM \`${table}\` WHERE \`id\` = ?`, [id]);
  return row ? String(row.status) : null;
};

const exists = async (table: string, id: number): Promise<boolean> =>
  (await db.count(`SELECT COUNT(*) FROM \`${table}\` WHERE \`id\` = ?`, [id])) === 1;

/** An open report on a row, filed by somebody else: what holds content past any window. */
const openReport = async (
  reporter: string,
  table: string,
  id: number,
  author: string
): Promise<number> =>
  await db.insert(
    'INSERT INTO `mica_reports` (`citizenid`, `target_table`, `target_id`, `category`, `target_author`) ' +
      "VALUES (?, ?, ?, 'other', ?)",
    [reporter, table, id, author]
  );

export const retentionScenarios: Scenario[] = [
  {
    // MICA-167, MICA-428: `micamedia prune` expires media older than the window — and leaves
    // shown what an open report holds, what a live message still shows, and what is younger.
    id: 'retention-micamedia-prune-keeps-held-media',
    mode: 'standalone',
    tickets: ['MICA-167', 'MICA-292'],
    timeoutMs: 45_000,
    run: async (signal) => {
      const tap = requireTap();
      const owner = unique('ret');
      const reporter = unique('ret_reporter');
      const previous = GetConvar(RETENTION_CONVAR, '');

      const aged = await mediaRow(owner, 10);
      const reported = await mediaRow(owner, 10);
      const attached = await mediaRow(owner, 10);
      const young = await mediaRow(owner, 0);
      await openReport(reporter, 'mica_media', reported, owner);

      // A live message showing `attached`. Its body is empty, which is what the backfill counts
      // as empty rather than as plaintext to seal.
      const conversation = await db.insert(
        'INSERT INTO `mica_messages_conversations` (`citizenid`) VALUES (?)',
        [owner]
      );
      const message = await db.insert(
        "INSERT INTO `mica_messages` (`citizenid`, `conversation_id`, `message`) VALUES (?, ?, '')",
        [owner, conversation]
      );
      await db.insert(
        'INSERT INTO `mica_messages_attachments` (`message_id`, `citizenid`, `photo_id`) VALUES (?, ?, ?)',
        [message, owner, attached]
      );

      // The window's grace, announced two days ago: the 24 hours a new window waits are over.
      await db.exec(
        'INSERT INTO `mica_schema_migrations` (`id`, `applied_at`) VALUES (?, NOW() - INTERVAL 2 DAY) ' +
          'ON DUPLICATE KEY UPDATE `applied_at` = NOW() - INTERVAL 2 DAY',
        [MARKER]
      );
      SetConvar(RETENTION_CONVAR, String(WINDOW_DAYS));
      try {
        // Asked again while micaOS's own retention pass holds mica_media; see mediaPrune.ts.
        const done = await runMediaPrune(tap, 30_000, signal);
        assert(done.startsWith('[micamedia] prune finished: '), done);
        const expired = Number(/prune finished: (\d+) expired/.exec(done)?.[1] ?? -1);
        assert(expired >= 1, `the prune expired ${expired} rows, not at least 1: ${done}`);

        const aged_ = await statusOf('mica_media', aged);
        assert(aged_ === 'expired', `aged, unheld media is ${aged_}, not expired and kept`);
        for (const [id, what] of [
          [reported, 'media under an open report'],
          [attached, 'media a live message shows'],
          [young, 'media younger than the window']
        ] as const) {
          const status = await statusOf('mica_media', id);
          assert(status === 'active', `${what} is ${status}, not active`);
        }
        assert(
          (await db.count('SELECT COUNT(*) FROM `mica_messages_attachments` WHERE `photo_id` = ?', [
            attached
          ])) === 1,
          "the live message's attachment row went with the prune"
        );
      } finally {
        SetConvar(RETENTION_CONVAR, previous);
        await db.exec('DELETE FROM `mica_schema_migrations` WHERE `id` = ?', [MARKER]);
      }
    }
  },
  {
    // MICA-168, MICA-300, MICA-428: a deleted character's rows are erased — content, media, a
    // resolved report, the photo somebody else reported too — and kept; their pending report,
    // their moderation-ledger row and the device's number stay live.
    id: 'purge-character-deleted-keeps-held-rows',
    mode: 'standalone',
    tickets: ['MICA-168', 'MICA-300', 'MICA-292'],
    timeoutMs: 45_000,
    run: async (signal) => {
      const tap = requireTap();
      const gone = unique('purged');
      const other = unique('purge_reporter');

      await db.insert('INSERT INTO `mica_phone_numbers` (`citizenid`, `number`) VALUES (?, ?)', [
        gone,
        `8${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`
      ]);
      const note = await db.insert(
        "INSERT INTO `mica_notes` (`citizenid`, `title`, `content`) VALUES (?, 'n', 'n')",
        [gone]
      );
      const contact = await db.insert(
        "INSERT INTO `mica_contacts` (`citizenid`, `firstname`, `phone`) VALUES (?, 'A', '1')",
        [gone]
      );
      const plainMedia = await mediaRow(gone, 0);
      const heldMedia = await mediaRow(gone, 0);
      const heldReport = await openReport(other, 'mica_media', heldMedia, gone);
      // Their own reports name somebody else's photo: a report on their own would hold it.
      const othersMedia = await mediaRow(other, 0);
      const ownPending = await openReport(gone, 'mica_media', othersMedia, other);
      const ownResolved = await db.insert(
        'INSERT INTO `mica_reports` (`citizenid`, `target_table`, `target_id`, `resolution`) ' +
          "VALUES (?, 'mica_media', ?, 'dismissed')",
        [gone, othersMedia]
      );
      const audit = await db.insert(
        'INSERT INTO `mica_audit_logs` (`citizenid`, `action`, `service`, `method`, `target_id`, `target_table`) ' +
          "VALUES (?, 'deleted', 'notes', 'delete', ?, 'mica_notes')",
        [gone, note]
      );

      // The line names the character by its log token (MICA-433), not its citizenid.
      const token = await serverWho(gone);
      const mark = tap.mark();
      emit('mica:server:shell:characterDeleted', gone);
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
      await sleep(250);

      for (const [table, id, what] of [
        ['mica_notes', note, 'note'],
        ['mica_contacts', contact, 'contact'],
        ['mica_media', plainMedia, 'photo'],
        ['mica_media', heldMedia, 'photo under an open report'],
        ['mica_reports', ownResolved, 'resolved report']
      ] as const) {
        const status = await statusOf(table, id);
        assert(status === 'erased', `the deleted character's ${what} is ${status}, not erased`);
      }
      const number = (
        await db.rows('SELECT `status` FROM `mica_phone_numbers` WHERE `citizenid` = ?', [gone])
      ).map((row) => String(row.status));
      assert(
        number.length === 1 && number[0] === 'active',
        `the deleted character's number is ${JSON.stringify(number)}, not one live row: it must stay held, so it is never issued again`
      );
      for (const [table, id, what] of [
        ['mica_reports', ownPending, 'their pending report'],
        ['mica_reports', heldReport, "the other player's report"],
        ['mica_media', othersMedia, "the other player's photo"]
      ] as const) {
        const status = await statusOf(table, id);
        assert(status === 'active', `${what} is ${status}, not active`);
      }
      assert(await exists('mica_audit_logs', audit), 'their moderation-ledger row is gone');
    }
  }
];
