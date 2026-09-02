// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findHardcodedScriptStrings, findHardcodedStrings } from './phone/hardcodedStrings';

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
/**
 * Where a `.ts` file is read too (MICA-217). Only the apps: the Store kept forty
 * permission labels in a `label:` table in `appInfo.ts`, which a rule about `.svelte`
 * files could not see. The shell's own `.ts` state (`audio.ts`'s ringtone names,
 * `toast.ts`'s call actions) still carries literals of the same shape and is not gated
 * here — widening the root is the way to take that on, and the failure list is the
 * ticket.
 */
const SCANNED_TS = ['web/src/apps'];

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (
      entry.name.endsWith(ext) &&
      !entry.name.endsWith(`.test${ext}`) &&
      !full.includes('__fixtures__')
    )
      out.push(full);
  }
  return out;
}

let scannedFiles = 0;

const counts = (): Map<string, { count: number; sample: string[] }> => {
  const result = new Map<string, { count: number; sample: string[] }>();
  const record = (file: string, found: { line: number; text: string }[]) => {
    scannedFiles += 1;
    if (found.length === 0) return;
    result.set(path.relative(ROOT, file), {
      count: found.length,
      sample: found.slice(0, 5).map((f) => `${f.line}: ${f.text}`)
    });
  };
  for (const root of SCANNED) {
    for (const file of walk(path.join(ROOT, root), '.svelte')) {
      record(file, findHardcodedStrings(fs.readFileSync(file, 'utf8')));
    }
  }
  for (const root of SCANNED_TS) {
    for (const file of walk(path.join(ROOT, root), '.ts')) {
      record(file, findHardcodedScriptStrings(fs.readFileSync(file, 'utf8')));
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

  it('reads the .ts files under apps/, where the Store kept its label table', () => {
    // A guard on the widening itself: if the `.ts` walk found nothing, the rule for the
    // table that started MICA-217 is not running, and the assertion below is vacuous.
    expect(walk(path.join(ROOT, 'web/src/apps'), '.ts').length).toBeGreaterThan(20);
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
