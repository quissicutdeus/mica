// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * What the server says to a player is said in the player's language (MICA-216).
 *
 * A `PlayerFacingError` and a `notifyPlayer` call carry English text the server composed,
 * and the server does not know the locale. Since MICA-216 each may carry a `key` into the
 * shell's `server` catalog (`web/src/shell/locales/server.en.json`), which the client
 * resolves. Two things are held here:
 *
 * 1. **Every key the server sends exists in the English catalog.** A key the catalog lacks
 *    falls back to the English text at runtime, silently — this is what makes it loud.
 * 2. **A ratchet on keyless sites.** Ninety-three `PlayerFacingError`s and a dozen
 *    `notifyPlayer`s predate the key; the count per file is frozen and may only fall, so
 *    the extraction cannot slip back and a new refusal has to carry a key from the start.
 *
 * A scanner, like `hardcodedStrings.test.ts`: a site it cannot see is not gated.
 */
const ROOT = join(__dirname, '..', '..');
const CATALOG = join(ROOT, 'web', 'src', 'shell', 'locales', 'server.en.json');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') walk(full, out);
    } else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
};

interface Site {
  file: string;
  line: number;
  kind: 'error' | 'notify';
  key: string | null;
}

/** The argument list of a call starting at `open` (the `(`), balancing parens. */
const callText = (text: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
};

const sites = (): Site[] => {
  const found: Site[] = [];
  for (const dir of ['server/services', 'server/lib']) {
    for (const file of walk(join(ROOT, dir))) {
      // Comments stripped (line numbers kept): `errors.ts`'s own docblock shows the shape
      // with an example key, and an example is not a site.
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) =>
        m.replace(/[^\n]/g, ' ')
      );
      const rel = relative(ROOT, file);
      for (const m of text.matchAll(/new PlayerFacingError\s*\(|notifyPlayer\s*\(/g)) {
        const kind = m[0].startsWith('new') ? 'error' : 'notify';
        const args = callText(text, m.index + m[0].length - 1);
        const key = /\bkey:\s*['"]([^'"]+)['"]/.exec(args)?.[1] ?? null;
        found.push({ file: rel, line: text.slice(0, m.index).split('\n').length, kind, key });
      }
    }
  }
  return found;
};

/** Keyless sites per file, frozen on 2026-09-02. Lower a number; never raise one. */
const KEYLESS_BASELINE: Record<string, number> = {
  'server/services/Battery.ts': 1,
  'server/services/Phone.ts': 1,

  'server/services/Seed.ts': 1
};

describe('server messages carry a key the client can resolve (MICA-216)', () => {
  const all = sites();
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8')) as Record<string, string>;

  it('scans a plausible amount of source', () => {
    expect(all.length).toBeGreaterThan(50);
    expect(Object.keys(catalog).length).toBeGreaterThan(0);
  });

  it('every key a site sends exists in the English catalog', () => {
    const missing = all
      .filter((s) => s.key !== null)
      .filter((s) => !s.key!.startsWith('server.') || !(s.key!.slice('server.'.length) in catalog))
      .map((s) => `${s.file}:${s.line} sends '${s.key}'`);
    expect(
      missing,
      'a key the catalog lacks falls back to English silently — add it to web/src/shell/locales/server.en.json (and .de.json)'
    ).toEqual([]);
  });

  it('no file has more keyless sites than its frozen count', () => {
    const counts = new Map<string, number>();
    for (const s of all) if (s.key === null) counts.set(s.file, (counts.get(s.file) ?? 0) + 1);
    const over = [...counts]
      .filter(([file, n]) => n > (KEYLESS_BASELINE[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} keyless (allowed ${KEYLESS_BASELINE[file] ?? 0})`);
    expect(
      over,
      'a new PlayerFacingError or notifyPlayer without a key would reach a player in English — give it { key } into the server catalog'
    ).toEqual([]);
  });

  it('the frozen counts are honest: a file that got better lowers its entry', () => {
    const counts = new Map<string, number>();
    for (const s of all) if (s.key === null) counts.set(s.file, (counts.get(s.file) ?? 0) + 1);
    const stale = Object.entries(KEYLESS_BASELINE)
      .filter(([file, allowed]) => (counts.get(file) ?? 0) < allowed)
      .map(([file, allowed]) => `${file}: now ${counts.get(file) ?? 0}, baseline says ${allowed}`);
    expect(stale, 'lower the baseline so the ratchet cannot slip back').toEqual([]);
  });
});
