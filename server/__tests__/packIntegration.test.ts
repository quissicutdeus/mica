// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  MODES,
  assembleRunEntries,
  expectedScenariosText,
  readZip,
  scenarioIds
  // @ts-expect-error -- a plain .js build script with no declaration file (declaring one is a non-test change).
} from '../../scripts/pack-integration.js';
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
  const file = (name: string, ids: string[], mode = 'standalone') => ({
    name,
    text: ids
      .map((id) => `  {\n    id: '${id}',\n    mode: '${mode}',\n    tickets: [],\n  },`)
      .join('\n')
  });
  const qbxFile = file('q.ts', ['qbx-one'], 'qbx');
  const esxFile = file('e.ts', ['esx-one'], 'esx');

  it('lists every declared scenario with its mode, sorted, and skips the index that only assembles them', () => {
    const found = scenarioIds([
      file('b.ts', ['beta-one']),
      file('a.ts', ['alpha-one', 'alpha-two']),
      qbxFile,
      esxFile,
      { name: 'index.ts', text: "  id: 'not-a-scenario'" }
    ]);

    expect(found).toEqual([
      { id: 'alpha-one', mode: 'standalone' },
      { id: 'alpha-two', mode: 'standalone' },
      { id: 'beta-one', mode: 'standalone' },
      { id: 'esx-one', mode: 'esx' },
      { id: 'qbx-one', mode: 'qbx' }
    ]);
  });

  it('does not read a type annotation or a number id as a scenario', () => {
    const text = "id: number,\n  id: 'real-one',\n  mode: 'standalone',\n  id: 7,";

    expect(scenarioIds([{ name: 'a.ts', text }, qbxFile, esxFile])).toEqual([
      { id: 'esx-one', mode: 'esx' },
      { id: 'qbx-one', mode: 'qbx' },
      { id: 'real-one', mode: 'standalone' }
    ]);
  });

  it('refuses a suite of none, a duplicate, and a run with nothing in it', () => {
    expect(() => scenarioIds([{ name: 'a.ts', text: 'nothing here' }])).toThrow(/no scenario ids/);
    expect(() => scenarioIds([file('a.ts', ['same', 'same']), qbxFile, esxFile])).toThrow(/twice/);
    expect(() => scenarioIds([file('a.ts', ['alone'])])).toThrow(/no scenario runs in qbx mode/);
    expect(() => scenarioIds([file('q.ts', ['alone'], 'qbx')])).toThrow(
      /no scenario runs in standalone mode/
    );
    // The third run is held to the same rule: a suite with no esx scenario has no esx run.
    expect(() => scenarioIds([file('a.ts', ['alone']), qbxFile])).toThrow(
      /no scenario runs in esx mode/
    );
  });

  it('refuses a scenario with no mode, or a mode there is not, naming it', () => {
    const bare = { name: 'a.ts', text: "  {\n    id: 'no-mode',\n    tickets: [],\n  }," };
    expect(() => scenarioIds([bare, qbxFile, esxFile])).toThrow(
      /scenario no-mode \(a\.ts\) declares no mode/
    );
    // Not on the next line, which is where the packer reads it: that is no mode too, by name.
    const sameLine = { name: 'a.ts', text: "  id: 'same-line', mode: 'qbx'," };
    expect(() => scenarioIds([sameLine, qbxFile, esxFile])).toThrow(
      /scenario same-line .* declares no mode/
    );
    expect(() => scenarioIds([file('a.ts', ['odd'], 'arm'), qbxFile, esxFile])).toThrow(
      /scenario odd \(a\.ts\) has mode 'arm'/
    );
  });
});

describe('expectedScenariosText', () => {
  it('lists every scenario in every run, as a pass where it belongs and a skip where it does not', () => {
    expect(
      expectedScenariosText([
        { id: 'alpha', mode: 'standalone' },
        { id: 'esx-one', mode: 'esx' },
        { id: 'qbx-one', mode: 'qbx' }
      ])
    ).toBe(
      [
        'standalone pass alpha',
        'standalone skip esx-one',
        'standalone skip qbx-one',
        'qbx skip alpha',
        'qbx skip esx-one',
        'qbx pass qbx-one',
        'esx skip alpha',
        'esx pass esx-one',
        'esx skip qbx-one',
        ''
      ].join('\n')
    );
    expect(MODES).toEqual(['standalone', 'qbx', 'esx']);
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
