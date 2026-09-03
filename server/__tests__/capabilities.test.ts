// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestEventFor, responseEventFor } from '@gos/shared/rpc';
import { ROUTES } from '@gos/shared/routes';

/**
 * Capture what the service registers, before the module graph loads.
 *
 * `vi.hoisted` for the reason `routes.test.ts` gives: ESM evaluates every `import` before
 * any module-level statement, so assigning the spy below the imports would record nothing
 * and every assertion here would pass vacuously.
 */
const { dbMock, handlers, framework } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured,
    // Mutable so each case can move the server under the service without re-importing it.
    framework: { kind: 'qb' as 'qb' | 'esx' | 'standalone' | 'unknown' }
  };
});

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  detectFramework: () => framework.kind,
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: 'CID', source: 5 })
  }
}));

import { capabilities } from '../services/Capabilities';
import { __resetRateLimits } from '../lib/rateLimit';

const REQUEST_EVENT = 'gos:server:shell:capabilities';

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  framework.kind = 'qb';
  (globalThis as any).emitNet = vi.fn();
});

describe('what money capability each framework answers', () => {
  it('refuses money in standalone, where there is none to move', () => {
    // The whole point of the endpoint. `FrameworkBridge` in standalone answers the
    // `-Infinity` sentinel from `getMoney` and `false` from both money moves, so Bank and
    // Hodlr have nothing behind them.
    framework.kind = 'standalone';
    expect(capabilities()).toEqual({ money: false });
  });

  it.each(['qb', 'esx'] as const)('allows money on %s', (kind) => {
    framework.kind = kind;
    expect(capabilities()).toEqual({ money: true });
  });

  it('allows money while the framework is still unknown', () => {
    /**
     * The load-bearing case, and the one a plain `=== 'standalone' ? true : false` reading
     * of the ticket would get wrong by folding `unknown` into "no framework".
     *
     * `unknown` means no framework has answered *yet*. FiveM starts resources in
     * `server.cfg` order and `ensure gos` above `ensure qb-core` is legal, so an
     * ordinary qb server passes through this state at boot. Answering `false` there would
     * take Bank and Hodlr off a working phone, silently, for the whole session — while
     * answering `true` on a server that really has no money costs an error message from a
     * money path that already fails closed.
     */
    framework.kind = 'unknown';
    expect(capabilities()).toEqual({ money: true });
  });

  it('reads the framework per call, so boot order does not freeze the answer', () => {
    // `detectFramework` is resolved inside the handler rather than captured at module
    // load, which is what lets the `unknown` above become `qb` once the core starts.
    framework.kind = 'unknown';
    expect(capabilities().money).toBe(true);
    framework.kind = 'standalone';
    expect(capabilities().money).toBe(false);
  });
});

describe('the registered net event', () => {
  it('is exactly gos:server:shell:capabilities', () => {
    // Pinned as a literal: this is the contract the client half derives, and a rename here
    // fails no compiler — the NUI callback would simply hang for 15s and time out.
    expect(handlers.has(REQUEST_EVENT)).toBe(true);
    expect(requestEventFor('shell', 'capabilities')).toBe(REQUEST_EVENT);
  });

  it('is what the typed call in web/src/services/capabilities.ts reaches', () => {
    // No route any more: the web reaches this with `call(shellContract, 'capabilities', …)`
    // over the generic service action (MICA-213), and `routes.test.ts` holds that call
    // site to this exact registered event and to a scoped browser mock.
    expect(ROUTES.find((r) => r.action === 'checkCapabilities')).toBeUndefined();
    expect(requestEventFor('shell', 'capabilities')).toBe(REQUEST_EVENT);
  });

  it('registers no generic CRUD on the shell service', () => {
    // §2.9: a registered net event is reachable whether or not a route points at it, and
    // `shell` has no table for a generic action to act on.
    const registered = [...handlers.keys()].filter((event) =>
      event.startsWith('gos:server:shell:')
    );
    for (const action of ['get', 'create', 'update', 'delete']) {
      expect(registered).not.toContain(`gos:server:shell:${action}`);
    }
  });
});

describe('what the handler answers over the wire', () => {
  const call = async (cbId: number) => {
    (globalThis as any).source = 5;
    await handlers.get(REQUEST_EVENT)!(cbId, undefined);
    return (globalThis.emitNet as any).mock.calls;
  };

  it('replies on the derived response event with the capability payload', async () => {
    framework.kind = 'standalone';
    const calls = await call(1);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(responseEventFor('shell', 'capabilities'));
    expect(calls[0][1]).toBe(5);
    expect(calls[0][2]).toBe(1);
    expect(calls[0][3]).toEqual({ money: false });
  });

  it('answers the same for every empty payload, and refuses a steered one', async () => {
    /**
     * Nothing in the request is read, so there is nothing here to steer — and the contract
     * now says so rather than leaving it to the handler happening not to look. The three
     * shapes an argument-less call can arrive as are answered; anything else is a client
     * asserting something nobody asked it for, and is refused.
     */
    framework.kind = 'qb';
    for (const empty of [undefined, null, {}]) {
      (globalThis as any).emitNet = vi.fn();
      (globalThis as any).source = 5;
      await handlers.get(REQUEST_EVENT)!(2, empty);
      expect((globalThis.emitNet as any).mock.calls[0][3], JSON.stringify(empty)).toEqual({
        money: true
      });
    }

    for (const steered of [42, 'money', { money: false }, [1, 2, 3]]) {
      (globalThis as any).emitNet = vi.fn();
      (globalThis as any).source = 5;
      await handlers.get(REQUEST_EVENT)!(2, steered);
      expect((globalThis.emitNet as any).mock.calls[0][3], JSON.stringify(steered)).toMatchObject({
        error: expect.any(String)
      });
    }
  });
});
