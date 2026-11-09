// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs before every test file in the web Vitest project (`setupFiles` in `vite.config.ts`).
 *
 * `pool: 'vmThreads'` runs a jsdom file inside jsdom's own VM context, so `globalThis` IS
 * jsdom's window rather than Node's global with the window's properties copied onto it.
 * jsdom 30's `Crypto` implements `getRandomValues` and `randomUUID` and nothing else, so
 * `crypto.subtle` is `undefined` there — and `sdk/remoteAppSecurity.ts`'s `sha256Hex`, which
 * every catalog install and rehydration goes through, threw on it. Under `pool: 'forks'` the
 * same files saw Node's own `crypto`, which is why nothing noticed before.
 *
 * Node's `webcrypto.subtle` is the same Web Crypto API every NUI-hosting browser ships, so
 * lending it to jsdom's `crypto` object changes no answer a test can get. Only the missing
 * member is added: jsdom's `getRandomValues`/`randomUUID` stay jsdom's, and a realm that
 * already has `subtle` (a node-environment file, or a future jsdom) is left alone.
 */
import { webcrypto } from 'node:crypto';

const realmCrypto = globalThis.crypto as Partial<Crypto> | undefined;

if (realmCrypto === undefined) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    enumerable: true,
    writable: true
  });
} else if (realmCrypto.subtle === undefined) {
  Object.defineProperty(realmCrypto, 'subtle', {
    value: webcrypto.subtle,
    configurable: true,
    enumerable: true
  });
}
