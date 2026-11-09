// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// MICA-471: where the add-on build writes, and who is allowed to write there.
//
// `build-addons.mjs` deletes and rewrites its output folder, so two builds into one folder
// race: on 2026-11-09 one run emptied `public/addons/` under another's build mid-copy.
// Two separate answers live here, both importable without starting Vite so a test can
// drive them with a stand-in build:
//
//   1. `MICA_BUILD_DIR` — a build root of its own. A run with it set shares nothing with
//      the checkout's default: add-ons go to `$MICA_BUILD_DIR/addons` and the shell build
//      to `$MICA_BUILD_DIR/web`. Unset, the paths are the ones `pnpm build` always used.
//   2. `acquireLock` — an exclusive lock on one output folder, so two runs aimed at the
//      same folder take turns instead of racing.
//
// Plain JS (not TS) because `build-addons.mjs` runs before anything can compile TypeScript;
// `addon-build.d.ts` carries the types for `vite*.config.ts` and the tests.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';

/** The env var naming a scratch build root. */
export const BUILD_DIR_ENV = 'MICA_BUILD_DIR';

/**
 * Where add-on bundles are written, absolute.
 *
 * The default is `web/public/addons`: the shell's `publicDir` is `public/`, so its own build
 * picks the bundles up from there. A scratch run points the shell at `$MICA_BUILD_DIR/web`
 * and copies the bundles in itself (see `vite.config.ts`).
 */
export function addonsOutDir(webDir, env = process.env) {
  const root = env[BUILD_DIR_ENV];
  return root ? path.resolve(root, 'addons') : path.join(webDir, 'public/addons');
}

/** Where the shell build is written, absolute. */
export function shellOutDir(webDir, env = process.env) {
  const root = env[BUILD_DIR_ENV];
  return root ? path.resolve(root, 'web') : path.resolve(webDir, '../dist/web');
}

/** Whether `pid` names a live process. EPERM means it exists and is somebody else's. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * The lock directory for `outDir`, keyed by the folder's absolute path. It lives in the OS
 * temp dir rather than beside the output: a sibling of `public/addons` would be copied into
 * `dist/web` by the shell build, and the build deletes the output itself.
 */
export const lockDirFor = (outDir) =>
  path.join(
    os.tmpdir(),
    `mica-addons-${createHash('sha1').update(path.resolve(outDir)).digest('hex').slice(0, 12)}.lock`
  );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readHolder = (lockDir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, 'holder.json'), 'utf8'));
  } catch {
    return null;
  }
};

const describe = (holder) =>
  holder
    ? `pid ${holder.pid}, started ${holder.startedAt}, ${holder.mode}: ${holder.command}`
    : 'an unknown holder (its record is not written yet)';

/**
 * Take an exclusive lock on `outDir` and return `{ release }`.
 *
 * The lock is the directory `lockDirFor(outDir)`, created with `mkdirSync` (atomic: exactly
 * one caller succeeds) and holding `holder.json`.
 *
 * - **Contention:** waits, logging the holder (pid, start time, mode, command), and throws
 *   once `timeoutMs` passes. It never proceeds without the lock.
 * - **Watch holder:** a `--watch` run holds the lock for as long as `pnpm dev` lives, so
 *   waiting is pointless; a caller who finds one throws at once, naming it.
 * - **Stale holder:** a holder whose pid is dead (killed, never released) is cleared. A
 *   record that never appears is cleared after `graceMs`. Clearing renames the lock away
 *   first, so only one waiter wins it. Pid reuse by an unrelated live process is not
 *   detected; the timeout still ends that wait loudly.
 * - **Release:** `release()` is idempotent and only removes a lock whose token is ours.
 *   Wiring it to exit and signals is the caller's, because only the caller knows what else
 *   must stop first.
 */
export async function acquireLock(outDir, options = {}) {
  const {
    command = process.argv.slice(1).join(' '),
    mode = 'build',
    timeoutMs = 300_000,
    pollMs = 250,
    graceMs = 10_000,
    announceMs = 10_000,
    log = (line) => process.stderr.write(`${line}\n`)
  } = options;
  const lockDir = lockDirFor(outDir);
  const token = randomBytes(8).toString('hex');
  const record = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    mode,
    command,
    token
  };
  const started = Date.now();
  let lastAnnounce = 0;

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'holder.json'), JSON.stringify(record));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    const holder = readHolder(lockDir);
    let age;
    try {
      age = Date.now() - fs.statSync(lockDir).mtimeMs;
    } catch {
      continue; // released between our mkdir and now: take it on the next lap
    }
    const stale = holder ? !pidAlive(holder.pid) : age > graceMs;
    if (stale) {
      log(`[micaOS] clearing a stale add-on build lock (${describe(holder)})`);
      const away = `${lockDir}.stale-${process.pid}-${token}`;
      // Re-read just before the rename: if the lock changed hands since we judged it,
      // leave it alone.
      if (JSON.stringify(readHolder(lockDir)) === JSON.stringify(holder)) {
        try {
          fs.renameSync(lockDir, away);
          fs.rmSync(away, { recursive: true, force: true });
        } catch {
          // another waiter cleared it first; fall through to the next lap
        }
      }
      continue;
    }

    if (holder?.mode === 'watch') {
      throw new Error(
        `[micaOS] ${outDir} is held by a watch run (${describe(holder)}). ` +
          `A watch run owns this folder for as long as it lives; stop it, or build into ` +
          `a folder of your own with ${BUILD_DIR_ENV}=<dir>.`
      );
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(
        `[micaOS] gave up after ${Math.round(timeoutMs / 1000)}s waiting for the add-on ` +
          `build lock on ${outDir}, held by ${describe(holder)}. If that run is gone, ` +
          `remove ${lockDir}.`
      );
    }
    if (Date.now() - lastAnnounce >= announceMs) {
      lastAnnounce = Date.now();
      log(`[micaOS] waiting for the add-on build lock on ${outDir}, held by ${describe(holder)}`);
    }
    await sleep(pollMs);
  }

  let released = false;
  return {
    lockDir,
    release() {
      if (released) return;
      released = true;
      if (readHolder(lockDir)?.token !== token) return;
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  };
}
