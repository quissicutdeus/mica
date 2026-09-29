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
  import type { Bytes } from 'node:buffer';

  interface Digest {
    toString(encoding: 'hex'): string;
    readonly length: number;
  }

  /**
   * AES-256-GCM, for `lib/contentCipher.ts` (MICA-165) — the third file the note above
   * anticipated. Typed only as far as that file uses it: one algorithm, bytes in and out.
   */
  interface CipherGCM {
    setAAD(data: Uint8Array): CipherGCM;
    update(data: Uint8Array): Bytes;
    final(): Bytes;
    getAuthTag(): Bytes;
  }

  interface DecipherGCM {
    setAAD(data: Uint8Array): DecipherGCM;
    setAuthTag(tag: Uint8Array): DecipherGCM;
    update(data: Uint8Array): Bytes;
    /** Throws when the tag does not authenticate the ciphertext and the AAD. */
    final(): Bytes;
  }

  interface GcmOptions {
    authTagLength: number;
  }

  export function createCipheriv(
    algorithm: 'aes-256-gcm',
    key: Uint8Array,
    iv: Uint8Array,
    options: GcmOptions
  ): CipherGCM;
  export function createDecipheriv(
    algorithm: 'aes-256-gcm',
    key: Uint8Array,
    iv: Uint8Array,
    options: GcmOptions
  ): DecipherGCM;

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
  /** Real bytes (`Bytes` is a `Digest` too, so `.toString('hex')` callers are unchanged). */
  export function randomBytes(size: number): Bytes;

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

/**
 * The byte type `node:crypto` above hands back, and the three `Buffer` statics
 * `lib/contentCipher.ts` needs to move between it, base64 and UTF-8 (MICA-165).
 *
 * A module declaration for the same reason as the rest of this file: the global `Buffer` lives
 * in `@types/node`'s ambient set, which this program cannot load. `Bytes` is a `Uint8Array`
 * with the string conversions actually called; nothing here pretends to be the whole `Buffer`.
 */
declare module 'node:buffer' {
  export interface Bytes extends Uint8Array {
    toString(encoding?: 'hex' | 'base64' | 'utf8'): string;
  }

  export const Buffer: {
    from(text: string, encoding: 'base64' | 'utf8'): Bytes;
    concat(list: readonly Uint8Array[]): Bytes;
  };
}
