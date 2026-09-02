// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findHardcodedStrings } from './phone/hardcodedStrings';

/**
 * The localization ratchet (MICA-61).
 *
 * Every user-facing string used to be an English literal in a `.svelte` file. The
 * mechanism now exists — `registerMessages` and `$t` — and the extraction is spread over
 * MICA-214 and MICA-215, so this file freezes the count of literals per file and lets
 * each number go **down only**. A file at zero is done; a file not listed must stay at zero,
 * which is what stops a new app, or a new string in a finished one, from decaying back to
 * English. When every entry is gone, the table goes with it and the rule is simply "none".
 *
 * `findHardcodedStrings` is a scanner and says what it covers; a literal it cannot see is
 * not gated here, so a green run is a floor, not proof of translation.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCANNED = ['web/src/apps', 'web/src/shell', 'sdk/ui'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.svelte') && !full.includes('__fixtures__')) out.push(full);
  }
  return out;
}

let scannedFiles = 0;

const counts = (): Map<string, { count: number; sample: string[] }> => {
  const result = new Map<string, { count: number; sample: string[] }>();
  for (const root of SCANNED) {
    for (const file of walk(path.join(ROOT, root))) {
      scannedFiles += 1;
      const found = findHardcodedStrings(fs.readFileSync(file, 'utf8'));
      if (found.length === 0) continue;
      result.set(path.relative(ROOT, file), {
        count: found.length,
        sample: found.slice(0, 5).map((f) => `${f.line}: ${f.text}`)
      });
    }
  }
  return result;
};

/** Frozen on 2026-09-01 when the mechanism landed. Lower a number; never raise one. */
const BASELINE: Record<string, number> = {};

describe('hardcoded user-facing strings (MICA-61)', () => {
  const live = counts();

  it('scans a plausible amount of source', () => {
    // Files scanned, not files with findings: the whole point is for the second number to
    // reach zero, and a guard on it would fail the day the extraction finished.
    expect(scannedFiles).toBeGreaterThan(150);
  });

  it('no file has more hardcoded strings than its frozen count', () => {
    const over: string[] = [];
    for (const [file, { count, sample }] of live) {
      const allowed = BASELINE[file] ?? 0;
      if (count > allowed) {
        over.push(`${file}: ${count} (allowed ${allowed})\n    ${sample.join('\n    ')}`);
      }
    }
    expect(
      over,
      'a user-facing string is hardcoded English — read it through $t and a registered catalog (MICA-61)'
    ).toEqual([]);
  });

  it('the frozen counts are honest: a file that got better lowers its entry', () => {
    const stale: string[] = [];
    for (const [file, allowed] of Object.entries(BASELINE)) {
      const count = live.get(file)?.count ?? 0;
      if (count < allowed) stale.push(`${file}: now ${count}, baseline says ${allowed}`);
    }
    expect(stale, 'lower the baseline to the new count so the ratchet cannot slip back').toEqual(
      []
    );
  });
});
