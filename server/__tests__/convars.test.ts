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
      const declared = text.match(
        new RegExp(`\\b${arg.replace(/[^\\w]/g, '')}\\s*=\\s*['"\`]([^'"\`]+)['"\`]`)
      );
      if (declared) found.push({ name: declared[1], file: where });
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
