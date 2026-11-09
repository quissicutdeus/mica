// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  acquireLock,
  addonsOutDir,
  lockDirFor,
  shellOutDir
} from '../../web/scripts/addon-build.js';

/**
 * The add-on build's output folder and the lock on it (MICA-471).
 *
 * `build-addons.mjs` deletes and rewrites its output folder. On 2026-11-09 two builds in one
 * checkout did that to each other, one emptying `public/addons/` under the other's copy, and
 * nothing said so. These tests drive the lock with a stand-in "build" (a child process that
 * clears a folder and writes files into it slowly, then checks they are all still there) so
 * a real Vite run is not needed, and `build-addons.mjs` itself with a stub `vite` on PATH.
 */

const ROOT = resolve(__dirname, '../..');
const WEB = join(ROOT, 'web');
const MODULE = join(WEB, 'scripts/addon-build.js');
const BUILD_ADDONS = join(WEB, 'scripts/build-addons.mjs');

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'mica-lock-test-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

interface Ran {
  code: number | null;
  out: string;
}

const run = (
  cmd: string,
  args: string[],
  env: Record<string, string> = {},
  onSpawn?: (child: ReturnType<typeof spawn>) => void
): Promise<Ran> =>
  new Promise((done) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (out += d));
    child.on('close', (code) => done({ code, out }));
    onSpawn?.(child);
  });

/** A build stand-in: take the lock, clear the folder, write 5 files slowly, check them. */
const writerScript = () => {
  const file = join(work, 'writer.mjs');
  writeFileSync(
    file,
    `import fs from 'node:fs';
import { acquireLock } from ${JSON.stringify(MODULE)};
const [out, tag] = process.argv.slice(2);
const lock = await acquireLock(out, { pollMs: 20, announceMs: 0, log: (l) => console.log(l) });
console.log('ACQUIRED');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (let i = 0; i < 5; i++) {
  fs.writeFileSync(out + '/' + tag + '-' + i, tag);
  await new Promise((r) => setTimeout(r, 60));
}
const names = fs.readdirSync(out).sort();
const whole = names.length === 5 && names.every((n, i) => n === tag + '-' + i);
console.log(whole ? 'WHOLE' : 'TORN ' + names.join(','));
lock.release();
`
  );
  return file;
};

const files = (dir: string) => readdirSync(dir).sort();

describe('output directory resolution', () => {
  it('defaults to public/addons and dist/web, and follows MICA_BUILD_DIR', () => {
    expect(addonsOutDir(WEB, {})).toBe(join(WEB, 'public/addons'));
    expect(shellOutDir(WEB, {})).toBe(join(ROOT, 'dist/web'));
    expect(addonsOutDir(WEB, { MICA_BUILD_DIR: '/x/scratch' })).toBe('/x/scratch/addons');
    expect(shellOutDir(WEB, { MICA_BUILD_DIR: '/x/scratch' })).toBe('/x/scratch/web');
  });
});

describe('the add-on build lock', () => {
  it('makes a second build into the same folder wait, and both outputs are whole', async () => {
    const out = join(work, 'default');
    const writer = writerScript();
    const [a, b] = await Promise.all([
      run('node', [writer, out, 'a']),
      run('node', [writer, out, 'b'])
    ]);

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    // Neither saw its own files disturbed while it held the lock.
    expect(a.out).toContain('WHOLE');
    expect(b.out).toContain('WHOLE');
    // Exactly one of them waited, and the message names the holder.
    const waiter = a.out.includes('waiting for the add-on build lock') ? a : b;
    expect(waiter.out).toMatch(/held by pid \d+, started \d{4}-.*build:/);
    // What is left is one writer's whole set, not a mix.
    const left = files(out);
    expect(left).toHaveLength(5);
    expect(new Set(left.map((n) => n.split('-')[0])).size).toBe(1);
    expect(existsSync(lockDirFor(out))).toBe(false);
  });

  it('lets builds into different folders run side by side without touching each other', async () => {
    const writer = writerScript();
    const [x, y] = [join(work, 'x'), join(work, 'y')];
    const [a, b] = await Promise.all([
      run('node', [writer, x, 'a']),
      run('node', [writer, y, 'b'])
    ]);
    expect(a.out).not.toContain('waiting');
    expect(b.out).not.toContain('waiting');
    expect(a.out).toContain('WHOLE');
    expect(b.out).toContain('WHOLE');
    expect(files(x).every((n) => n.startsWith('a-'))).toBe(true);
    expect(files(y).every((n) => n.startsWith('b-'))).toBe(true);
  });

  it('clears a lock whose holder is dead instead of waiting on it forever', async () => {
    const out = join(work, 'stale');
    const dead = await run('node', ['-e', 'process.stdout.write(String(process.pid))']);
    const lockDir = lockDirFor(out);
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, 'holder.json'),
      JSON.stringify({
        pid: Number(dead.out),
        startedAt: '2026-01-01T00:00:00.000Z',
        mode: 'build',
        command: 'killed',
        token: 'old'
      })
    );
    const lines: string[] = [];
    const lock = await acquireLock(out, { timeoutMs: 2000, pollMs: 20, log: (l) => lines.push(l) });
    expect(lines.join('\n')).toContain('stale');
    lock.release();
    expect(existsSync(lockDir)).toBe(false);
  });

  it('clears a lock that never got a holder record once it is old enough', async () => {
    const out = join(work, 'bare');
    mkdirSync(lockDirFor(out));
    const lock = await acquireLock(out, { timeoutMs: 2000, pollMs: 20, graceMs: 0, log: () => {} });
    lock.release();
    expect(existsSync(lockDirFor(out))).toBe(false);
  });

  it('gives up loudly, naming a live holder, rather than proceeding', async () => {
    const out = join(work, 'busy');
    const held = await acquireLock(out, { command: 'the holder', log: () => {} });
    await expect(acquireLock(out, { timeoutMs: 150, pollMs: 20, log: () => {} })).rejects.toThrow(
      new RegExp(`gave up.*pid ${process.pid}.*the holder`)
    );
    held.release();
  });

  it('fails at once, naming it, when the holder is a watch run', async () => {
    const out = join(work, 'watching');
    const held = await acquireLock(out, { mode: 'watch', command: 'pnpm dev', log: () => {} });
    const began = Date.now();
    await expect(acquireLock(out, { timeoutMs: 60_000, pollMs: 20 })).rejects.toThrow(
      /watch run.*pnpm dev/
    );
    expect(Date.now() - began).toBeLessThan(2000);
    held.release();
  });

  it('release leaves a lock that is no longer ours alone', async () => {
    const out = join(work, 'taken');
    const mine = await acquireLock(out, { log: () => {} });
    rmSync(mine.lockDir, { recursive: true });
    const theirs = await acquireLock(out, { log: () => {} });
    mine.release();
    expect(existsSync(theirs.lockDir)).toBe(true);
    theirs.release();
  });
});

describe('build-addons.mjs', () => {
  /** A `vite` that takes a moment, then writes the bundle it was asked for. */
  const stubBin = (body = '') => {
    const bin = join(work, 'bin');
    mkdirSync(bin);
    const vite = join(bin, 'vite');
    writeFileSync(
      vite,
      `#!/usr/bin/env node
const fs = require('node:fs');
${body}
const dir = process.env.MICA_BUILD_DIR + '/addons';
fs.mkdirSync(dir, { recursive: true });
setTimeout(() => {
  fs.writeFileSync(dir + '/' + process.env.ADDON_ID + '.js', 'x');
  process.exit(0);
}, 120);
`
    );
    chmodSync(vite, 0o755);
    return { PATH: `${bin}:${process.env.PATH}` };
  };

  it('takes turns with a second run into the same folder, and runs --then under the lock', async () => {
    const env = { ...stubBin(), MICA_BUILD_DIR: join(work, 'scratch') };
    const then = join(work, 'then.mjs');
    writeFileSync(
      then,
      `import fs from 'node:fs';
const n = fs.readdirSync(process.env.MICA_BUILD_DIR + '/addons').length;
console.log('SHELL SAW ' + n);
`
    );
    const [a, b] = await Promise.all([
      run('node', [BUILD_ADDONS, '--then', 'node', then], env),
      run('node', [BUILD_ADDONS, '--then', 'node', then], env)
    ]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const counts = [a, b].map((r) => /SHELL SAW (\d+)/.exec(r.out)?.[1]);
    // Both shell steps saw every bundle: neither run's folder was emptied under it.
    expect(counts[0]).toBe(counts[1]);
    expect(Number(counts[0])).toBeGreaterThan(0);
    expect([a, b].filter((r) => r.out.includes('waiting for the add-on build lock'))).toHaveLength(
      1
    );
    expect(existsSync(lockDirFor(join(work, 'scratch/addons')))).toBe(false);
  }, 30_000);

  it('releases the lock when a build fails', async () => {
    const env = { ...stubBin('process.exit(3);'), MICA_BUILD_DIR: join(work, 'failing') };
    const r = await run('node', [BUILD_ADDONS], env);
    expect(r.code).toBe(3);
    expect(existsSync(lockDirFor(join(work, 'failing/addons')))).toBe(false);
  }, 30_000);

  it('releases the lock on SIGTERM, and a one-shot build refuses while a watch run holds it', async () => {
    const dir = join(work, 'watch');
    const env = { ...stubBin('setInterval(() => {}, 1000);'), MICA_BUILD_DIR: dir };
    const lockDir = lockDirFor(join(dir, 'addons'));
    let watcher!: ReturnType<typeof spawn>;
    const watching = run('node', [BUILD_ADDONS, '--watch'], env, (c) => (watcher = c));
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(lockDir, 'holder.json')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(join(lockDir, 'holder.json'))).toBe(true);

    const refused = await run('node', [BUILD_ADDONS], env);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/held by a watch run \(pid \d+/);

    watcher.kill('SIGTERM');
    const ended = await watching;
    expect(ended.code).toBe(143);
    expect(existsSync(lockDir)).toBe(false);
  }, 30_000);
});
