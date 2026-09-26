// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A narrow, hand-written shape for `node:fs`, for the two files that read the resource's own
 * folders — `locales/` (`lib/locales.ts`, MICA-235) and `branding/` (`lib/ownerConfig.ts`,
 * MICA-236) — not the real `@types/node`. Both use exactly these four calls.
 *
 * The same reasoning as `nodeCrypto.d.ts`, and the same limit: `server/tsconfig.json` cannot
 * load `@types/node`, whose ambient `exports` collides with `@citizenfx/server`'s (TS2403), so a
 * module declaration covering exactly the calls made is the working option. Four synchronous
 * calls, typed only as far as they are used. A third Node built-in, or a caller wanting more
 * of this one, is the point to solve the `exports` conflict properly instead.
 */
declare module 'node:fs' {
  interface Stats {
    isFile(): boolean;
    isDirectory(): boolean;
    readonly size: number;
  }

  export function existsSync(path: string): boolean;
  export function statSync(path: string): Stats;
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
