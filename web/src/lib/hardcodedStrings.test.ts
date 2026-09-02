// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findHardcodedStrings } from './phone/hardcodedStrings';

/**
 * No user-facing string is hardcoded English (MICA-61).
 *
 * This began as a ratchet: a frozen count of literals per `.svelte` file — 771 across 97
 * files on 2026-09-01 — that could only fall while MICA-214 and MICA-215 extracted
 * them. Every entry is gone now, so the table is gone with it and the rule is simply the
 * one it was converging on: a `.svelte` file under these roots reads its strings through
 * `$t` and a registered catalog, and a new one starts that way.
 *
 * `findHardcodedStrings` is a scanner and says what it covers; a literal it cannot see is
 * not gated here, so a green run is a floor, not proof of translation. What the server
 * composes and sends is MICA-216's.
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

describe('hardcoded user-facing strings (MICA-61)', () => {
  const live = counts();

  it('scans a plausible amount of source', () => {
    // Files scanned, not files with findings: the whole point is for the second number to
    // reach zero, and a guard on it would fail the day the extraction finished.
    expect(scannedFiles).toBeGreaterThan(150);
  });

  it('no file has a hardcoded user-facing string', () => {
    const offenders = [...live].map(
      ([file, { count, sample }]) => `${file}: ${count}\n    ${sample.join('\n    ')}`
    );
    expect(
      offenders,
      'a user-facing string is hardcoded English — read it through $t and a registered catalog (MICA-61)'
    ).toEqual([]);
  });
});
