// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { MICA_DEV_ADDON_MARKER } from '../../shared/addonDev';

/**
 * `scripts/check-no-dev-addon.js` fires (MICA-311).
 *
 * It runs against the real `dist/web` at the end of `build:nocheck`, which proves the build
 * is clean today. What that cannot show is that the check would notice if it were not, and a
 * check nobody has seen fail is a check that may never be able to. Each case here builds a
 * tree and runs the script as a child process, because the contract is its exit code.
 */

const SCRIPT = resolve(__dirname, '../../scripts/check-no-dev-addon.js');
const MARKER = 'mica-dev-addon';

const roots: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mica-no-dev-addon-'));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const check = (dir: string) => {
  const run = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  return { code: run.status, out: `${run.stdout}${run.stderr}` };
};

/** A plausible clean web build: an index, a chunk, and a nested asset. */
const cleanTree = (): string => {
  const dir = scratch();
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><script src="./assets/a.js"></script>');
  writeFileSync(join(dir, 'assets', 'a.js'), 'export const x = 1;');
  return dir;
};

describe('check-no-dev-addon', () => {
  it('passes a tree without the marker', () => {
    const { code, out } = check(cleanTree());
    expect(out).toContain('none containing the marker');
    expect(code).toBe(0);
  });

  it('fails a planted marker and names the file holding it', () => {
    const dir = cleanTree();
    writeFileSync(join(dir, 'assets', 'devAddon-abc123.js'), `const m = "${MARKER}";`);
    const { code, out } = check(dir);
    expect(code).toBe(1);
    expect(out).toContain('devAddon-abc123.js');
    expect(out).not.toContain('assets/a.js');
    expect(out).toContain('1 of 3 files');
  });

  it('finds the marker in the entry page and in a source map, not only in .js', () => {
    const inHtml = cleanTree();
    writeFileSync(join(inHtml, 'index.html'), `<!-- ${MARKER} -->`);
    expect(check(inHtml).code).toBe(1);

    const inMap = cleanTree();
    writeFileSync(join(inMap, 'assets', 'a.js.map'), `{"sources":["${MARKER}.ts"]}`);
    expect(check(inMap).code).toBe(1);
  });

  it('fails when the directory does not exist', () => {
    const { code, out } = check(join(scratch(), 'never-built'));
    expect(code).toBe(1);
    expect(out).toContain('does not exist');
  });

  it('fails when the directory is empty', () => {
    const { code, out } = check(scratch());
    expect(code).toBe(1);
    expect(out).toContain('is empty');
  });

  it('fails when the directory holds files but is not a web build', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'stray.js'), 'export {};');
    const { code, out } = check(dir);
    expect(code).toBe(1);
    expect(out).toContain('no index.html');
  });

  it('fails when pointed at a file rather than a directory', () => {
    const dir = cleanTree();
    expect(check(join(dir, 'index.html')).code).toBe(1);
  });

  /**
   * Both scripts are plain node and cannot import a `.ts` constant, so each spells the marker
   * out. This is what makes that safe: if the dev path's marker changes and either copy does
   * not, the check would scan for a string nothing carries and pass every build.
   */
  it.each(['scripts/check-no-dev-addon.js', 'scripts/smoke-image.js'])(
    '%s spells the marker the dev path carries',
    (file) => {
      const source = readFileSync(resolve(__dirname, '../..', file), 'utf8');
      const spelled = source.match(/(?:const MARKER|const DEV_ADDON_MARKER) = '([^']+)'/)?.[1];
      expect(spelled).toBe(MICA_DEV_ADDON_MARKER);
    }
  );

  describe('pack-resource.js', () => {
    const PACK = resolve(__dirname, '../../scripts/pack-resource.js');

    /** The files `pack-resource.js` requires, so it reaches the check rather than stopping early. */
    const builtTree = (extra: string): string => {
      const cwd = scratch();
      for (const dir of ['client', 'server', 'web/addons'])
        mkdirSync(join(cwd, 'dist', dir), { recursive: true });
      writeFileSync(join(cwd, 'dist/client/client.js'), '');
      writeFileSync(join(cwd, 'dist/server/server.js'), '');
      writeFileSync(join(cwd, 'dist/web/index.html'), extra);
      return cwd;
    };
    const pack = (cwd: string) => {
      const run = spawnSync(process.execPath, [PACK, 'v2026.10.06.1'], { cwd, encoding: 'utf8' });
      return `${run.stdout}${run.stderr}`;
    };

    it('refuses to pack a tree carrying the marker', () => {
      const out = pack(builtTree(`<!-- ${MARKER} -->`));
      expect(out).toContain('refusing to pack a tree that failed check-no-dev-addon');
    });

    it('does not stop at the check when the tree is clean', () => {
      // It goes on to fail later, on the empty branding/ in this fake tree; what matters is
      // that the refusal above is specific to the marker and not to every run.
      const out = pack(builtTree('<!doctype html>'));
      expect(out).toContain('none containing the marker');
      expect(out).not.toContain('refusing to pack');
    });
  });
});
