// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Node built-ins the integration suite reaches for, typed only as far as it uses them.
 *
 * Not `@types/node`, for the reason `server/lib/nodeFs.d.ts` gives: its ambient `exports`
 * collides with `@citizenfx/server`'s (TS2403). Module declarations load only because
 * something imports them, so they never touch the global scope that conflict lives in. This
 * program includes `integration/` alone, so these do not meet the server's own shims.
 */
declare module 'node:buffer' {
  export interface Bytes extends Uint8Array {
    toString(encoding?: 'hex' | 'base64' | 'utf8'): string;
    subarray(start?: number, end?: number): Bytes;
  }

  export const Buffer: {
    from(text: string, encoding: 'base64' | 'utf8'): Bytes;
    concat(list: readonly Uint8Array[]): Bytes;
  };
}

declare module 'node:crypto' {
  import type { Bytes } from 'node:buffer';

  interface DecipherGCM {
    setAAD(data: Uint8Array): DecipherGCM;
    setAuthTag(tag: Uint8Array): DecipherGCM;
    update(data: Uint8Array): Bytes;
    /** Throws when the tag does not authenticate the ciphertext and the AAD. */
    final(): Bytes;
  }

  export function createDecipheriv(
    algorithm: 'aes-256-gcm',
    key: Uint8Array,
    iv: Uint8Array,
    options: { authTagLength: number }
  ): DecipherGCM;
  export function randomBytes(size: number): Bytes;
}

declare module 'node:fs' {
  interface Stats {
    readonly mode: number;
  }

  export function existsSync(path: string): boolean;
  export function statSync(path: string): Stats;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function unlinkSync(path: string): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
}
