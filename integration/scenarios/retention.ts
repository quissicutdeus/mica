// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { requireTap } from '../lib/console';
import { db } from '../lib/db';
import { assert, unique } from '../lib/mica';
import { runMediaPrune } from '../lib/mediaPrune';
import { sleep } from '../lib/wait';

/**
 * Age-based retention (MICA-167) and the character-deleted purge (MICA-168, MICA-300), on
 * fixture rows, through the two doors a server owner has: `micamedia prune` from the console and
 * the `mica:server:shell:characterDeleted` event another server resource fires.
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
    // MICA-167: `micamedia prune` removes media older than the window — and keeps what an open
    // report holds, what a live message still shows, and what is younger than the window.
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

        assert(!(await exists('mica_media', aged)), 'aged, unheld media survived the prune');
        assert(await exists('mica_media', reported), 'media under an open report was pruned');
        assert(await exists('mica_media', attached), 'media a live message shows was pruned');
        assert(await exists('mica_media', young), 'media younger than the window was pruned');
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
    // MICA-168, MICA-300: a deleted character's rows go — content, media, the device's number,
    // a resolved report — while their pending report, their moderation-ledger rows and their
    // media under somebody else's open report stay.
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

      const mark = tap.mark();
      emit('mica:server:shell:characterDeleted', gone);
      const said = await tap.waitFor(
        mark,
        new RegExp(`^\\[mica\\] (purged \\d+ row\\(s\\)|purge for) .*${gone}`),
        30_000,
        signal,
        "the purge's summary"
      );
      assert(said.startsWith('[mica] purged'), said);
      await sleep(250);

      assert(!(await exists('mica_notes', note)), "the deleted character's note survived");
      assert(!(await exists('mica_contacts', contact)), "the deleted character's contact survived");
      assert(!(await exists('mica_media', plainMedia)), "the deleted character's photo survived");
      assert(
        (await db.count('SELECT COUNT(*) FROM `mica_phone_numbers` WHERE `citizenid` = ?', [
          gone
        ])) === 0,
        "the deleted character's number survived"
      );
      assert(!(await exists('mica_reports', ownResolved)), 'their resolved report survived');
      assert(await exists('mica_reports', ownPending), 'their pending report was purged');
      assert(await exists('mica_audit_logs', audit), 'their moderation-ledger row was purged');
      assert(await exists('mica_media', heldMedia), 'their photo under an open report was purged');
      assert(await exists('mica_reports', heldReport), "the other player's report was purged");
      assert(await exists('mica_media', othersMedia), "the other player's photo was purged");
    }
  }
];
