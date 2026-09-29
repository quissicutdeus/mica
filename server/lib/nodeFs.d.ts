// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A narrow, hand-written shape for `node:fs`, for the two files that read the resource's own
 * folders — `locales/` (`lib/locales.ts`, MICA-235) and `branding/` (`lib/ownerConfig.ts`,
 * MICA-236) — and the one that reads and writes the content key file (`lib/contentCipher.ts`,
 * MICA-165). Not the real `@types/node`.
 *
 * The same reasoning as `nodeCrypto.d.ts`, and the same limit: `server/tsconfig.json` cannot
 * load `@types/node`, whose ambient `exports` collides with `@citizenfx/server`'s (TS2403), so a
 * module declaration covering exactly the calls made is the working option. Synchronous calls,
 * typed only as far as they are used. A caller wanting much more of this is the point to solve
 * the `exports` conflict properly instead.
 */
declare module 'node:fs' {
  interface Stats {
    isFile(): boolean;
    isDirectory(): boolean;
    readonly size: number;
    /** Permission bits and file type. `lib/contentCipher.ts` reads the permission half. */
    readonly mode: number;
  }

  interface WriteOptions {
    /** Applied only when the file is created. */
    mode: number;
    /** `'wx'`: create, and fail with `EEXIST` rather than overwrite. */
    flag: 'wx';
  }

  export function existsSync(path: string): boolean;
  export function statSync(path: string): Stats;
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
  /** Resolves symlinks and `..`; throws when the path does not exist. */
  export function realpathSync(path: string): string;
  export function writeFileSync(path: string, data: string, options: WriteOptions): void;
}

/**
 * Where the server was started from, which is server-data (MICA-165: a content key must not
 * sit in the directory backed up beside the database it protects), and whether it runs on
 * Windows, where permission bits mean nothing. Beside `node:fs` because both are the
 * filesystem questions `lib/contentCipher.ts` asks.
 */
declare module 'node:process' {
  export function cwd(): string;
  export const platform: string;
}
