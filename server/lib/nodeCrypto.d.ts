// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A narrow, hand-written shape for the one Node built-in `server/` code reaches for
 * (`Lockscreen.ts`, MICA-60) — not the real `@types/node`.
 *
 * `server/tsconfig.json` deliberately does not list `"node"` in `compilerOptions.types`:
 * `@types/node`'s ambient `module.d.ts` declares a global `exports` of type `any`, and
 * `@citizenfx/server` declares its own global `exports: CitizenExports` — loading both
 * ambient sets in the same program is a hard conflict (`TS2403`), not a style choice to
 * relitigate. This file sidesteps it entirely: it is a *module* declaration
 * (`declare module 'node:crypto'`), which TypeScript loads because something imports it,
 * not because it is an ambient global package — so nothing here ever touches the global
 * scope `exports`/`Buffer`/`require` live in, and the conflict never has a chance to occur.
 *
 * Deliberately not `Buffer`-shaped. The real Node types return `Buffer` from `digest()`/
 * `randomBytes()`, and typing that honestly means pulling in `@types/node`'s global
 * `Buffer` declaration — the same problem one layer down. `Lockscreen.ts` never needs
 * anything a hex string and a length cannot express, so `Digest` below is exactly that:
 * enough surface for `.toString('hex')` and `.length`, and nothing that pretends to be a
 * real `Buffer` a caller might reach for other `Buffer` methods on.
 *
 * If a third file ever needs a real Node builtin this shim does not cover, that is the
 * signal to solve the `exports` conflict properly (a scoped `/// <reference>`, a
 * declaration-merging override, or moving the hash into its own tiny build target) rather
 * than growing this file into a second `@types/node`.
 */
declare module 'node:crypto' {
  interface Digest {
    toString(encoding: 'hex'): string;
    readonly length: number;
  }

  interface Hash {
    update(data: string): Hash;
    digest(): Digest;
  }

  /**
   * scrypt's cost parameters, which MICA-164 puts behind convars so an operator on weak
   * hardware can tune them. `maxmem` is not a tuning knob: Node refuses a call whose
   * working set exceeds it, and the requirement is `128 * N * r`, so it is derived from the
   * other two rather than guessed.
   */
  interface ScryptOptions {
    N?: number;
    r?: number;
    p?: number;
    maxmem?: number;
  }

  export function createHash(algorithm: string): Hash;
  export function randomBytes(size: number): Digest;

  /**
   * The callback form, deliberately, and never `scryptSync`.
   *
   * A tuned scrypt is *supposed* to take ~100ms — that is the entire point of it — and
   * `scryptSync` spends that on the thread FXServer runs the whole server on. One player
   * unlocking their phone would stutter the tick for everyone. The callback form hands the
   * work to libuv's pool and leaves the game thread alone.
   */
  export function scrypt(
    password: string,
    salt: string,
    keylen: number,
    options: ScryptOptions,
    callback: (err: Error | null, derivedKey: Digest) => void
  ): void;
}
