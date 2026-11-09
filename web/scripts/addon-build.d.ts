// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Types for `addon-build.js`, which is plain JS so `build-addons.mjs` can import it too. */

export declare const BUILD_DIR_ENV: 'MICA_BUILD_DIR';
export declare function addonsOutDir(
  webDir: string,
  env?: Record<string, string | undefined>
): string;
export declare function shellOutDir(
  webDir: string,
  env?: Record<string, string | undefined>
): string;
export declare function lockDirFor(outDir: string): string;
export declare function pidAlive(pid: number): boolean;

export interface LockOptions {
  command?: string;
  mode?: 'build' | 'watch';
  timeoutMs?: number;
  pollMs?: number;
  graceMs?: number;
  announceMs?: number;
  log?: (line: string) => void;
}

export interface Lock {
  lockDir: string;
  release(): void;
}

export declare function acquireLock(outDir: string, options?: LockOptions): Promise<Lock>;
