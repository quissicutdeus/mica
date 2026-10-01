// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { formatReport, type ImportReport } from '../lib/import/report';
import { REPORT_END, tableLines } from '../../integration/lib/importReport';

/**
 * MICA-302: the importer scenario reads `micaimport`'s report off the console, so its patterns
 * are held here to what `formatReport` really prints. For two hoth runs the end-of-report pattern
 * asked for one space more than `formatReport` writes; the dry run's last line never matched,
 * the scenario timed out on the dry run, and `--apply` was never sent — read as "the apply
 * hangs". These fail on that pattern.
 */
const table = (name: string, over: Partial<ImportReport['tables'][number]> = {}) => ({
  table: name,
  present: true,
  read: 1,
  written: 1,
  skipped: [],
  ...over
});

const report = (apply: boolean): ImportReport =>
  ({
    source: 'qb-phone',
    apply,
    tables: [
      table('player_contacts'),
      table('phone_messages', { written: 0, skipped: [{ reason: 'already imported', count: 1 }] }),
      table('phone_gallery'),
      table('phone_tweets', { present: false, read: 0, written: 0 })
    ]
  }) as ImportReport;

describe("the importer scenario's reading of micaimport's report", () => {
  it.each([false, true])('finds the last line of a real report (apply %s)', (apply) => {
    const lines = formatReport(report(apply));
    const ends = lines.filter((line) => REPORT_END.test(line));
    expect(ends).toEqual([lines[lines.length - 1]]);
    expect(ends[0]).toContain('phone_tweets');
  });

  it('also stops on a failed or refused run', () => {
    expect(REPORT_END.test('[micaimport] qb-phone failed part-way; rows already written')).toBe(
      true
    );
    expect(REPORT_END.test('[micaimport] an import is already running; wait.')).toBe(true);
  });

  it('parses every table line of a dry run and of an apply', () => {
    expect(tableLines(formatReport(report(false)))).toEqual([
      { table: 'player_contacts', read: 1, written: 1, skipped: 0 },
      { table: 'phone_messages', read: 1, written: 0, skipped: 1 },
      { table: 'phone_gallery', read: 1, written: 1, skipped: 0 }
    ]);
    expect(tableLines(formatReport(report(true)))).toHaveLength(3);
  });
});
