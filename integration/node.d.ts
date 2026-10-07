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
    indexOf(value: number | string | Uint8Array, byteOffset?: number): number;
    equals(other: Uint8Array): boolean;
  }

  export const Buffer: {
    from(text: string, encoding: 'base64' | 'utf8'): Bytes;
    from(data: Uint8Array | readonly number[]): Bytes;
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

  export interface KeyObject {
    export(options: { type: 'spki'; format: 'der' }): Bytes;
    export(options: { type: 'pkcs8'; format: 'pem' }): string;
  }

  export function generateKeyPairSync(
    type: 'ec',
    options: { namedCurve: 'prime256v1' }
  ): { publicKey: KeyObject; privateKey: KeyObject };
  /** ECDSA answers a DER `ECDSA-Sig-Value`, which is what an X.509 signature holds. */
  export function sign(algorithm: 'sha256', data: Uint8Array, key: KeyObject): Bytes;
}

declare module 'node:https' {
  import type { Bytes } from 'node:buffer';

  interface Socket {
    destroy(): void;
  }

  export interface IncomingMessage {
    readonly method?: string;
    readonly url?: string;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly socket: Socket;
    on(event: 'data', listener: (chunk: Bytes) => void): IncomingMessage;
    on(event: 'end', listener: () => void): IncomingMessage;
    on(event: 'error', listener: (error: Error) => void): IncomingMessage;
  }

  export interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string>): ServerResponse;
    end(body?: string): void;
  }

  export interface Server {
    listen(port: number, host: string, listening: () => void): Server;
    address(): { port: number } | string | null;
    close(closed?: (error?: Error) => void): Server;
    closeAllConnections(): void;
    on(event: 'error' | 'tlsClientError' | 'clientError', listener: (error: Error) => void): Server;
    once(event: 'error', listener: (error: Error) => void): Server;
  }

  export function createServer(
    options: { key: string; cert: string },
    listener: (request: IncomingMessage, response: ServerResponse) => void
  ): Server;
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
