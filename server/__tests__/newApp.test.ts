// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
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
    expect(files.svelte.map((f) => relative(run.appDir, f)).sort()).toEqual(svelte);
    // Non-vacuity: the scan below reads real class names out of both kinds of file.
    const markup = files.svelte.flatMap(
      (f) => componentClasses(readFileSync(f, 'utf8'), relative(root, f)).usages
    );
    expect(markup.length, 'no class read out of the generated markup').toBeGreaterThan(0);
    const manifest = join(run.appDir, 'manifest.ts');
    expect(existsSync(manifest)).toBe(true);
    expect(tileClasses(readFileSync(manifest, 'utf8'), 'manifest.ts')).not.toEqual([]);
  });

  it.each([
    ['a plain app', 'plain'],
    ['an app with --service --tablet', 'full']
  ])('writes %s that passes the SDK checks', (_label, name) => {
    const run = runs[name];
    const { violations } = checkAddonSources(collectFiles([run.appDir], root), { cwd: root });
    expect(
      violations.map((v) => `${v.file}:${v.line} ${v.rule} ${v.message}`),
      'scripts/new-app.js writes an app that fails the checks every app is held to — fix the ' +
        'template string in the script, not the generated file'
    ).toEqual([]);
  });
});
