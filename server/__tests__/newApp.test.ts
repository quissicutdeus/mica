// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { checkAddonSources, collectFiles } from '../../sdk/checks/addon.js';
import { componentClasses, tileClasses } from '../../sdk/checks/classes.js';

/**
 * What `pnpm new:app` writes, held to the checks micaOS holds every app to. MICA-312.
 *
 * Nothing ran the scaffolder before this, so a class it emitted was checked only after
 * someone scaffolded an app into `web/src/apps/` and `utilityClasses.test.ts` read it. That
 * is how its tile shipped `bg-slate-500`, which `sdk/app-utilities.css` has never defined,
 * and its `--service` view a `text-gray-300` that is not there either: every new app started
 * with a tile that rendered nothing.
 *
 * The scaffolder writes relative to its own location, so it runs from a temporary copy of
 * the directories it reads and writes — working tree, not `HEAD`, so an uncommitted edit to
 * the script is what gets tested — and the generated app is read with `sdk/checks/`: the
 * class scan, the `Screen` sizing rules and the CEF text checks, exactly as an add-on's
 * `pnpm check` runs them. Offline, and no `node_modules`: the script and the barrel
 * generator it calls import nothing but Node built-ins.
 */

const ROOT = resolve(__dirname, '../..');
const COPIED = ['scripts', 'sdk', 'server', 'client', 'shared', 'package.json'];
/** Where a service's browser mock lives, one file per service, globbed (MICA-323). */
const MOCKS = 'web/src/nui/mocks/services';
const TAKEN = '// an existing service mock the scaffolder must not overwrite\n';

/**
 * Every relative import in a generated file that names no file, in the temporary copy the
 * scaffold wrote into or in this repo — `web/` is not copied, so what a generated file
 * reaches there is looked up here.
 *
 * Not a typecheck: the copy has no `node_modules`, and running `svelte-check` over a
 * scaffold costs a minute. But a dead path is the failure this has actually shipped — the
 * store template imported `./createCrudStore` for months after MICA-172 moved it to
 * `sdk/`, and nothing ran the output to notice.
 */
const unresolvedImports = (root: string, file: string): string[] => {
  const text = readFileSync(join(root, file), 'utf8');
  const specs = [...text.matchAll(/(?:from\s+|import\()['"](\.{1,2}\/[^'"]+)['"]/g)].map(
    (m) => m[1]
  );
  expect(specs.length, `${file} has no relative import to check`).toBeGreaterThan(0);
  return specs.filter((spec) => {
    const target = join(dirname(file), spec);
    return ![root, ROOT].some((base) =>
      ['', '.ts', '.js', '.svelte', '/index.ts'].some((ext) => existsSync(join(base, target + ext)))
    );
  });
};

/** One scaffold run, and the app directory it wrote. */
interface Scaffold {
  code: number;
  output: string;
  appDir: string;
}

describe('pnpm new:app output', () => {
  let root = '';
  const runs: Record<string, Scaffold> = {};

  const scaffold = (id: string, flags: string[]) =>
    new Promise<Scaffold>((done) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== 'NODE_ENV' && !k.startsWith('VITEST'))
      );
      execFile(
        process.execPath,
        ['scripts/new-app.js', id, ...flags],
        { cwd: root, env, timeout: 60_000 },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          done({ code, output: `${stdout}\n${stderr}`, appDir: join(root, 'web/src/apps', id) });
        }
      );
    });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mica-new-app-'));
    for (const entry of COPIED) {
      cpSync(join(ROOT, entry), join(root, entry), {
        recursive: true,
        filter: (src) => !/(^|[\\/])(node_modules|dist)([\\/]|$)/.test(relative(ROOT, src))
      });
    }
    // Sequential: both runs rewrite `sdk/appContract.test.ts` and the generated barrels.
    runs.plain = await scaffold('scaffold_plain', []);
    runs.full = await scaffold('scaffold_full', ['--service', '--tablet']);
    // An id whose mock file already exists — `phone`, `shell` and `client` answer mocks
    // without being apps — must be refused before anything is written over it.
    mkdirSync(join(root, MOCKS), { recursive: true });
    writeFileSync(join(root, MOCKS, 'scaffold_taken.ts'), TAKEN);
    runs.taken = await scaffold('scaffold_taken', ['--service']);
  }, 120_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['a plain app', 'plain', ['Icon.svelte', 'index.svelte']],
    ['an app with --service --tablet', 'full', ['Icon.svelte', 'index.svelte', 'tablet.svelte']]
  ])('scaffolds %s', (_label, name, svelte) => {
    const run = runs[name];
    expect(run.code, run.output).toBe(0);
    const files = collectFiles([run.appDir], root);
    expect(files.svelte.map((f: string) => relative(run.appDir, f)).sort()).toEqual(svelte);
    // Non-vacuity: the scan below reads real class names out of both kinds of file.
    const markup = files.svelte.flatMap(
      (f: string) => componentClasses(readFileSync(f, 'utf8'), relative(root, f)).usages
    );
    expect(markup.length, 'no class read out of the generated markup').toBeGreaterThan(0);
    const manifest = join(run.appDir, 'manifest.ts');
    expect(existsSync(manifest)).toBe(true);
    expect(tileClasses(readFileSync(manifest, 'utf8'), 'manifest.ts')).not.toEqual([]);
  });

  /**
   * MICA-420: the launcher glyph's fallback size is the `size-icon-xl` token (2rem), the
   * scale every in-tree app's `Icon.svelte` now uses, not a raw `h-8 w-8` copied into each
   * new app.
   */
  it('scaffolds a launcher icon sized by the xl icon token', () => {
    const icon = readFileSync(join(runs.plain.appDir, 'Icon.svelte'), 'utf8');
    expect(icon).toContain("className = 'size-icon-xl'");
    expect(icon).not.toContain('h-8 w-8');
  });

  it.each([
    ['a plain app', 'plain'],
    ['an app with --service --tablet', 'full']
  ])('writes %s that passes the SDK checks', (_label, name) => {
    const run = runs[name];
    const { violations } = checkAddonSources(collectFiles([run.appDir], root), { cwd: root });
    expect(
      violations.map(
        (v: { file: string; line: number; rule: string; message: string }) =>
          `${v.file}:${v.line} ${v.rule} ${v.message}`
      ),
      'scripts/new-app.js writes an app that fails the checks every app is held to — fix the ' +
        'template string in the script, not the generated file'
    ).toEqual([]);
  });

  /**
   * `--service` writes its own mock file rather than printing a block to paste into a
   * shared one (MICA-323). The declaration is the exact line `routes.test.ts` reads as
   * text, and the four CRUD names are the ones the generated store calls — a mock under
   * any other name answers nothing, which is the dead-in-`pnpm dev` failure.
   */
  it('writes the browser mock for --service, and none for a plain app', () => {
    expect(existsSync(join(root, MOCKS, 'scaffold_plain.ts'))).toBe(false);
    const mock = readFileSync(join(root, MOCKS, 'scaffold_full.ts'), 'utf8');
    expect(mock).toMatch(/^export const mocks\b[^\n]*=\s*\{$/m);
    // Scoped keys, matching the store's `service` option — the generic route's request shape.
    for (const action of ['get', 'create', 'update', 'delete']) {
      expect(mock, action).toContain(`'scaffold_full:${action}'`);
    }
    expect(runs.full.output).not.toContain('mocks/registry.ts');
    expect(runs.full.output).toContain(`${MOCKS}/scaffold_full.ts`);
  });

  /**
   * The typed app contract has to cover the new app, tablet root included. The registration
   * matched only `index.svelte` imports, which are not one block once a tablet root sits
   * among them, and wrote the file back unchanged — nothing said so, and the typecheck then
   * failed on the row it had added (`Cannot find name`).
   */
  it('registers the scaffolded app and its tablet root in the typed app contract', () => {
    const contract = readFileSync(join(root, 'sdk/appContract.test.ts'), 'utf8');
    expect(contract).toContain(
      "import ScaffoldFull from '../web/src/apps/scaffold_full/index.svelte';"
    );
    expect(contract).toContain(
      "import ScaffoldFullTablet from '../web/src/apps/scaffold_full/tablet.svelte';"
    );
    expect(contract).toContain('scaffold_full: ScaffoldFull,');
    expect(contract).toContain('scaffold_full: ScaffoldFullTablet');
  });

  it('refuses an id whose mock file already exists, and writes nothing', () => {
    expect(runs.taken.code, runs.taken.output).not.toBe(0);
    expect(runs.taken.output).toContain(`${MOCKS}/scaffold_taken.ts already exists`);
    expect(readFileSync(join(root, MOCKS, 'scaffold_taken.ts'), 'utf8')).toBe(TAKEN);
    expect(existsSync(join(root, 'web/src/apps/scaffold_taken'))).toBe(false);
  });

  it('writes a --service browser mock whose relative imports all resolve', () => {
    expect(unresolvedImports(root, `${MOCKS}/scaffold_full.ts`)).toEqual([]);
  });

  /**
   * MICA-331: `--service` once wrote `sdk/host/use<Pascal>.ts`, importing `../../services/<id>`,
   * a directory that does not exist. It now writes what Notes is: an app-local store on the
   * SDK's factory and no hook file, so there is nothing in `sdk/` for a path to break.
   */
  it('writes a --service store inside the app, and no SDK hook', () => {
    expect(existsSync(join(root, 'sdk/host/useScaffoldFull.ts'))).toBe(false);
    expect(existsSync(join(root, 'web/src/services/scaffold_full.ts'))).toBe(false);
    const store = readFileSync(join(root, 'web/src/apps/scaffold_full/store.ts'), 'utf8');
    expect(store).toContain("from '@mica/sdk'");
    expect(store).toContain("service: 'scaffold_full'");
    expect(runs.full.output).not.toContain('Paste into it');
  });
});
