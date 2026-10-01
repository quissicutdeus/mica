// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How the importer scenario reads `micaimport`'s report off the console (MICA-233, MICA-302),
 * kept apart from the scenario so `integrationImportReport.test.ts` can hold it to what
 * `server/lib/import/report.ts`'s `formatReport` actually prints.
 *
 * That test is here because this pattern was wrong for two hoth runs: it asked for four spaces
 * between `[micaimport]` and a table name where `formatReport` prints three, so the dry run's
 * own last line never matched, the scenario waited out its whole timeout on the dry run, and
 * `--apply` was never sent at all. The runs read as "the apply hangs"; there was no apply.
 */

/** The line that ends a qb-phone report — `phone_tweets` is its last table, present or not. */
export const REPORT_END =
  /^\[micaimport\] {3}phone_tweets: |^\[micaimport\] (qb-phone failed part-way|an import is already running)/;

export const TABLE_LINE =
  /^\[micaimport\] {3}([a-z_#]+): read (\d+), (?:written|would write) (\d+), skipped (\d+)$/;

export interface TableLine {
  table: string;
  read: number;
  written: number;
  skipped: number;
}

/** Every per-table line of a report, parsed. */
export const tableLines = (lines: readonly string[]): TableLine[] =>
  lines.flatMap((line) => {
    const m = TABLE_LINE.exec(line);
    return m
      ? [{ table: m[1], read: Number(m[2]), written: Number(m[3]), skipped: Number(m[4]) }]
      : [];
  });
