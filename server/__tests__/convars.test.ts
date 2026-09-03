// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every convar a server owner can set is documented, enforced.
 *
 * MICA-73 found six of seven knobs written down nowhere a server owner would look. The
 * documentation is the fix; this is what stops it drifting back, and it is the same shape
 * as `eventNames.test.ts` — scan the source for the real thing, then hold the prose to it.
 *
 * The failure this prevents is quiet in both directions. A convar added without a doc entry
 * is invisible to the person it exists for, and a documented default that no longer matches
 * the code is worse than silence, because it is believed.
 */
const ROOT = join(__dirname, '..', '..');
const SCAN = ['client', 'server', 'shared'];
const DOCS = ['README.md'];

const walk = (dir: string): string[] => {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
};

/**
 * Resolve a `const IDENTIFIER = 'value'` declaration for a `GetConvar*` argument that is
 * a bare identifier rather than a string literal.
 *
 * Exported from the test module (not `server/lib`) purely so a unit test below can prove
 * this actually discriminates a real declaration from an unrelated one, rather than only
 * being exercised indirectly by the real repo scan.
 *
 * `arg` has already been trimmed to something that looks like an identifier by the caller;
 * `[^\w]` (a negated *word*-character class) strips anything that survived that isn't
 * `[A-Za-z0-9_]`, so the built regex's `\b<ident>\s*=` anchors on the identifier itself. A
 * class written `[^\\w]` — "not a backslash and not a literal w" — strips everything else
 * instead, including every letter but `w`, and collapses almost any identifier to `''`; the
 * resulting `\b\s*=\s*['"\`]...` then matches the *first* quoted assignment anywhere in the
 * file, which is a false pass, not a failure to resolve.
 */
const resolveConstConvarName = (arg: string, text: string): string | null => {
  const identifier = arg.replace(/[^\w]/g, '');
  if (!identifier) return null;
  const declared = text.match(new RegExp(`\\b${identifier}\\s*=\\s*['"\`]([^'"\`]+)['"\`]`));
  return declared ? declared[1] : null;
};

/**
 * The convar name at each `GetConvar*` call site.
 *
 * The first argument is a literal at some call sites and a `const` at others, so an
 * identifier is resolved against a declaration in the same file rather than skipped —
 * skipping it is how a scan like this silently passes while checking four of seven.
 */
const readConvarNames = (): { name: string; file: string }[] => {
  const found: { name: string; file: string }[] = [];
  for (const file of SCAN.flatMap((d) => walk(join(ROOT, d)))) {
    const text = readFileSync(file, 'utf8');
    const where = relative(ROOT, file);
    for (const m of text.matchAll(/GetConvar(?:Int|Bool)?\(\s*([^,)]+)/g)) {
      const arg = m[1].trim();
      const literal = arg.match(/^['"`](.+)['"`]$/);
      if (literal) {
        found.push({ name: literal[1], file: where });
        continue;
      }
      const resolved = resolveConstConvarName(arg, text);
      if (resolved !== null) found.push({ name: resolved, file: where });
      else found.push({ name: `UNRESOLVED:${arg} (${where})`, file: where });
    }
  }
  return found;
};

const documentation = (): string => DOCS.map((d) => readFileSync(join(ROOT, d), 'utf8')).join('\n');

describe('convar documentation (MICA-73)', () => {
  const convars = readConvarNames();

  it('finds the convar call sites, so the checks below are not vacuous', () => {
    // A regex that matched nothing would make every assertion here pass by default, which
    // is the exact failure mode AGENTS.md warns about: a check that reads as a pass.
    expect(convars.length).toBeGreaterThanOrEqual(7);
  });

  it('resolves every convar name, rather than quietly skipping the ones behind a const', () => {
    const unresolved = convars.filter((c) => c.name.startsWith('UNRESOLVED:')).map((c) => c.name);

    expect(unresolved, 'a convar name this scan cannot read is a convar it cannot check').toEqual(
      []
    );
  });

  it('documents every convar the code reads', () => {
    const docs = documentation();
    const undocumented = [...new Set(convars.map((c) => c.name))]
      .filter((name) => !docs.includes(name))
      .map((name) => `${name} (read in ${convars.find((c) => c.name === name)?.file})`);

    expect(undocumented, `add it to ${DOCS.join(', ')} — see MICA-73`).toEqual([]);
  });
});

describe('resolveConstConvarName (MICA-124)', () => {
  // The regression this guards: a scanner that resolves an identifier to '' and then
  // matches the file's first quoted assignment, regardless of which const it actually
  // names, passes on a decoy and never proves it read the real declaration.

  it('finds the declaration the call site actually names, not an earlier unrelated one', () => {
    const text = `
      const APP = 'blabber';
      const EDIT_WINDOW_CONVAR = 'gos_blabber_edit_window';
      GetConvar(EDIT_WINDOW_CONVAR, '900');
    `;

    expect(resolveConstConvarName('EDIT_WINDOW_CONVAR', text)).toBe('gos_blabber_edit_window');
  });

  it('does NOT fall back to an earlier decoy assignment when the real one is later', () => {
    // Same fixture as above, but this proves the negative: asking for the wrong name must
    // fail this assertion, so the test can actually catch the `[^\\w]` regression rather
    // than trivially passing regardless of which string comes out.
    const text = `
      const APP = 'blabber';
      const EDIT_WINDOW_CONVAR = 'gos_blabber_edit_window';
      GetConvar(EDIT_WINDOW_CONVAR, '900');
    `;

    expect(resolveConstConvarName('EDIT_WINDOW_CONVAR', text)).not.toBe('blabber');
  });

  it('returns null — not a coincidental match — when no matching declaration exists', () => {
    const text = `
      const SOMETHING_ELSE = 'gos_unrelated';
      GetConvar(TYPOED_CONVAR, '30');
    `;

    expect(resolveConstConvarName('TYPOED_CONVAR', text)).toBeNull();
  });
});
