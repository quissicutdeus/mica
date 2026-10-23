// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isAdmin } from './Admin';
import { notifyPlayer } from '../lib/shell';
import { formatBytes } from '../lib/media/stats';
import {
  STORAGE_TAG,
  formatStorageReport,
  readStorageReport,
  totalBytes
} from '../lib/storageReport';
import { traceOf } from '../lib/sqlErrors';

/**
 * `micastorage`: every `mica_` table's size and its rows by status, largest first, and a total
 * (`server/lib/storageReport.ts` reads and formats it). Report-only, like `micamedia` without
 * its `prune` half: nothing here writes, so there is no subcommand and no dry run to be one.
 *
 * **Gated like `micamedia`**: the console and any `isAdmin` caller. The breakdown goes to the
 * server console, where a line per table fits; an in-game admin also gets a one-line toast so
 * they know it ran. It names tables, statuses, counts and sizes, never a player.
 *
 * **One report at a time.** Each run counts every table, so a second `micastorage` while one is
 * reading is refused rather than doubling the scan.
 */

let reporting = false;

export const runStorageCommand = async (source: number): Promise<void> => {
  if (!isAdmin(source)) {
    notifyPlayer(source, {
      type: 'error',
      message: 'You do not have permission to use that.',
      key: 'server.storage.noPermission'
    });
    return;
  }

  if (reporting) {
    console.log(
      `${STORAGE_TAG} a report is already running; run micastorage again when it has finished.`
    );
    if (source !== 0) {
      notifyPlayer(source, {
        type: 'error',
        message: 'A storage report is already running. Try again when it has finished.',
        key: 'server.storage.busy'
      });
    }
    return;
  }

  reporting = true;
  try {
    const report = await readStorageReport();
    for (const line of formatStorageReport(report)) console.log(line);

    if (source !== 0) {
      const size = formatBytes(totalBytes(report));
      notifyPlayer(source, {
        type: 'success',
        message: `micastorage: ${report.tables.length} tables, ${size} — see server console for the breakdown.`,
        key: 'server.storage.report',
        params: { tables: report.tables.length, size }
      });
    }
  } finally {
    reporting = false;
  }
};

RegisterCommand(
  'micastorage',
  (source: number) => {
    void runStorageCommand(source).catch((error) => {
      console.error(`${STORAGE_TAG} failed:`, traceOf(error));
    });
  },
  false
);
