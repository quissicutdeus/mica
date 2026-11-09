// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * `scripts/check-markdown-chunks.js` fires (MICA-449).
 *
 * Against the real build it proves today's tree; what it cannot show is that it would notice
 * a regression, so each case here builds a web tree and an apps tree and runs the script as a
 * child process — the contract is its exit code. The libraries are planted by signature, the
 * same strings the script looks for; the last case holds those strings to the real packages.
 */

const SCRIPT = resolve(__dirname, '../../scripts/check-markdown-chunks.js');
const MARKED = 'x.walkTokens=1;';
const PURIFY = 'p.uponSanitizeElement=1;';

const roots: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mica-markdown-chunks-'));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const write = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const check = (dist: string, apps: string) => {
  const run = spawnSync(process.execPath, [SCRIPT, dist, apps], { encoding: 'utf8' });
  return { code: run.status, out: `${run.stdout}${run.stderr}` };
};

const RENDERS = `<script lang="ts">\n  import { renderMarkdown, Screen } from '@mica/sdk';\n</script>`;
const PLAIN = `<script lang="ts">\n  import { Screen } from '@mica/sdk';\n</script>`;

/**
 * A clean build: an entry that statically imports a vendor chunk, a lazy markdown chunk, a
 * `notes` add-on that renders markdown and holds both libraries, a `snek` that holds neither.
 */
const cleanTree = () => {
  const root = scratch();
  const dist = join(root, 'dist');
  const apps = join(root, 'apps');
  write(
    join(dist, 'index.html'),
    '<!doctype html><script type="module" crossorigin src="./assets/index-a.js"></script>' +
      '<link rel="modulepreload" crossorigin href="./assets/vendor-b.js">'
  );
  write(
    join(dist, 'assets/index-a.js'),
    'import{t}from"./vendor-b.js";const l=()=>import("./markdown-c.js");'
  );
  write(join(dist, 'assets/vendor-b.js'), 'export const t=1;');
  write(join(dist, 'assets/markdown-c.js'), `${MARKED}${PURIFY}`);
  write(join(dist, 'addons/notes.js'), `${MARKED}${PURIFY}`);
  write(join(dist, 'addons/snek.js'), 'export {};');
  for (const [id, body] of [
    ['notes', RENDERS],
    ['snek', PLAIN]
  ]) {
    write(join(apps, id, 'manifest.ts'), `export default defineApp({ id: '${id}', core: false });`);
    write(join(apps, id, 'index.svelte'), body);
  }
  // A core app is not an add-on, and its bundle is not looked for.
  write(join(apps, 'phone/manifest.ts'), `export default defineApp({ id: 'phone', core: true });`);
  write(join(apps, 'phone/index.svelte'), RENDERS);
  return { dist, apps };
};

describe('check-markdown-chunks', () => {
  it('passes a build where only the add-on that renders markdown holds the libraries', () => {
    const { dist, apps } = cleanTree();
    const { code, out } = check(dist, apps);
    expect(out).toContain('2 startup chunks hold neither library');
    expect(out).toContain('notes render markdown and hold both');
    expect(out).toContain('1 other add-ons hold neither');
    expect(code).toBe(0);
  });

  it('fails a modulepreloaded chunk holding a library, and names it', () => {
    const { dist, apps } = cleanTree();
    write(join(dist, 'assets/vendor-b.js'), `export const t=1;${PURIFY}`);
    const { code, out } = check(dist, apps);
    expect(code).toBe(1);
    expect(out).toContain('vendor-b.js (startup) holds DOMPurify');
    expect(out).not.toContain('markdown-c.js');
  });

  it('follows a static import the page never preloaded', () => {
    const { dist, apps } = cleanTree();
    write(join(dist, 'assets/vendor-b.js'), 'import"./markdown-c.js";export const t=1;');
    const { code, out } = check(dist, apps);
    expect(code).toBe(1);
    expect(out).toContain('markdown-c.js (startup) holds marked and DOMPurify');
  });

  it('fails an add-on that never calls renderMarkdown but holds one library', () => {
    const { dist, apps } = cleanTree();
    write(join(dist, 'addons/snek.js'), MARKED);
    const { code, out } = check(dist, apps);
    expect(code).toBe(1);
    expect(out).toContain('snek.js never calls renderMarkdown but holds marked');
  });

  it('fails an add-on that renders markdown when a signature no longer matches', () => {
    const { dist, apps } = cleanTree();
    write(join(dist, 'addons/notes.js'), MARKED);
    const { code, out } = check(dist, apps);
    expect(code).toBe(1);
    expect(out).toContain('notes.js renders markdown but no DOMPurify signature matched');
  });

  it('holds a second renderer to the positive rule without naming it', () => {
    const { dist, apps } = cleanTree();
    write(join(apps, 'snek/components/Board.svelte'), RENDERS);
    const { code, out } = check(dist, apps);
    expect(code).toBe(1);
    expect(out).toContain('snek.js renders markdown but no marked or DOMPurify signature');
  });

  it('fails when no add-on renders markdown, since nothing then proves the signatures', () => {
    const { dist, apps } = cleanTree();
    write(join(apps, 'notes/index.svelte'), PLAIN);
    write(join(dist, 'addons/notes.js'), 'export {};');
    const { code, out } = check(dist, apps);
    expect(code).toBe(1);
    expect(out).toContain('no add-on');
  });

  it('fails when an add-on in the source tree was not built', () => {
    const { dist, apps } = cleanTree();
    rmSync(join(dist, 'addons/snek.js'));
    const { code, out } = check(dist, apps);
    expect(code).toBe(1);
    expect(out).toContain('was not built');
  });

  it('fails a page that loads no module script', () => {
    const { dist, apps } = cleanTree();
    write(join(dist, 'index.html'), '<!doctype html><p>no script</p>');
    const { code, out } = check(dist, apps);
    expect(code).toBe(1);
    expect(out).toContain('loads no module script');
  });

  it('fails when the build or its index.html is missing', () => {
    const { dist, apps } = cleanTree();
    expect(check(join(dist, 'never-built'), apps).out).toContain('does not exist');
    rmSync(join(dist, 'index.html'));
    const { code, out } = check(dist, apps);
    expect(code).toBe(1);
    expect(out).toContain('no index.html');
  });

  /**
   * The signatures are the script's whole view of the libraries. Read from the installed
   * packages, so an upgrade that renames either API fails here as well as in the build.
   */
  it('spells signatures both installed packages still carry', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const sdk = createRequire(resolve(__dirname, '../../sdk/package.json'));
    for (const [pkg, name] of [
      ['marked', 'marked'],
      ['dompurify', 'DOMPurify']
    ]) {
      const signature = source.match(new RegExp(`name: '${name}', signature: '([A-Za-z]+)'`))?.[1];
      expect(signature, `${name} has a signature in the script`).toBeTruthy();
      expect(readFileSync(sdk.resolve(pkg), 'utf8')).toContain(signature);
    }
  });
});
