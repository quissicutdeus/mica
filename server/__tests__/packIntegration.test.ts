// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// @ts-expect-error -- a plain .js build script with no types; this suite is not typechecked.
import { assembleRunEntries, readZip, scenarioIds } from '../../scripts/pack-integration.js';
// @ts-expect-error -- same.
import { createZip } from '../../scripts/lib/zip.js';

/**
 * The integration run's zip (MICA-302): the release zip's `mica/` plus `mica-integration/`.
 *
 * The packer itself runs only in the release job and `integration.yml`, so the pure parts
 * are held here on every push, like `packResource.test.ts` does for the release zip: that
 * what it reads back is what `createZip` wrote, and that it refuses a resource or a suite
 * missing the files the box's scripts look for.
 */

const ROOT = resolve(__dirname, '../..');
const MTIME = new Date(Date.UTC(2026, 8, 2));
type Entry = { path: string; data: Buffer | string };

const mica: Entry[] = [
  { path: 'mica/fxmanifest.lua', data: "fx_version 'cerulean'\n" },
  { path: 'mica/mica.esx.sql', data: '-- sql\n'.repeat(500) },
  { path: 'mica/dist/server/server.js', data: 'x'.repeat(4000) }
];
const suite: Entry[] = [
  { path: 'fxmanifest.lua', data: "fx_version 'cerulean'\n" },
  { path: 'server.js', data: 'console.log(1)\n' },
  { path: 'expected-scenarios.txt', data: 'a\nb\n' }
];

describe('readZip', () => {
  it('reads back what createZip wrote, deflated and stored alike', () => {
    const entries = [...mica, { path: 'mica/empty', data: '' }];
    const back = readZip(createZip(entries, { mtime: MTIME })) as Array<{
      path: string;
      data: Buffer;
    }>;

    expect(back.map((e) => e.path).sort()).toEqual(entries.map((e) => e.path).sort());
    for (const e of entries) {
      expect(back.find((b) => b.path === e.path)?.data.toString()).toBe(e.data.toString());
    }
  });

  it('refuses a buffer that is not a zip', () => {
    expect(() => readZip(Buffer.from('not a zip at all, nothing here'))).toThrow(/not a zip/);
  });
});

describe('assembleRunEntries', () => {
  const toEntries = (list: Entry[]) =>
    list.map((e) => ({ path: e.path, data: Buffer.from(e.data) }));

  it('puts the suite beside mica/ and leaves mica/ as the release packer made it', () => {
    const out = assembleRunEntries(toEntries(mica), toEntries(suite)) as Array<{ path: string }>;

    expect(out.map((e) => e.path)).toEqual([
      ...mica.map((e) => e.path),
      'mica-integration/fxmanifest.lua',
      'mica-integration/server.js',
      'mica-integration/expected-scenarios.txt'
    ]);
  });

  it('refuses a resource without the files the wrapper reads', () => {
    expect(() => assembleRunEntries(toEntries(mica.slice(0, 1)), toEntries(suite))).toThrow(
      /mica\.esx\.sql/
    );
  });

  it('refuses a suite with no bundle', () => {
    expect(() => assembleRunEntries(toEntries(mica), toEntries(suite.slice(0, 1)))).toThrow(
      /server\.js/
    );
  });

  it('refuses a suite packed without its list of expected scenarios', () => {
    expect(() => assembleRunEntries(toEntries(mica), toEntries(suite.slice(0, 2)))).toThrow(
      /expected-scenarios/
    );
  });

  it('refuses a release zip that already holds the suite', () => {
    const tainted = [...mica, { path: 'mica/mica-integration/server.js', data: '' }];

    expect(() => assembleRunEntries(toEntries(tainted), toEntries(suite))).toThrow(/already holds/);
  });

  it('refuses entries outside mica/', () => {
    expect(() =>
      assembleRunEntries(toEntries([...mica, { path: 'stray.txt', data: '' }]), toEntries(suite))
    ).toThrow(/outside mica\//);
  });
});

describe('scenarioIds', () => {
  const file = (name: string, ids: string[]) => ({
    name,
    text: ids.map((id) => `  {\n    id: '${id}',\n    tickets: [],\n  },`).join('\n')
  });

  it('lists every declared id, sorted, and skips the index that only assembles them', () => {
    const ids = scenarioIds([
      file('b.ts', ['beta-one']),
      file('a.ts', ['alpha-one', 'alpha-two']),
      { name: 'index.ts', text: "  id: 'not-a-scenario'" }
    ]);

    expect(ids).toEqual(['alpha-one', 'alpha-two', 'beta-one']);
  });

  it('does not read a type annotation or a number id as a scenario', () => {
    const text = "id: number,\n  id: 'real-one',\n  id: 7,";

    expect(scenarioIds([{ name: 'a.ts', text }])).toEqual(['real-one']);
  });

  it('refuses a suite of none, and a duplicate', () => {
    expect(() => scenarioIds([{ name: 'a.ts', text: 'nothing here' }])).toThrow(/no scenario ids/);
    expect(() => scenarioIds([file('a.ts', ['same', 'same'])])).toThrow(/twice/);
  });
});

describe('the wiring', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

  it('builds the suite as part of build:nocheck, so verify builds it on every push', () => {
    expect(pkg.scripts['build:nocheck']).toContain('pnpm build:integration');
  });

  it('typechecks it as its own target, which the typecheck fan-out picks up by name', () => {
    expect(pkg.scripts['typecheck:integration']).toBe('tsc --noEmit -p integration/tsconfig.json');
    expect(pkg.scripts.typecheck).toContain('pnpm:typecheck:*');
  });
});
