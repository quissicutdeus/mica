// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { requestEventFor, GENERIC_SERVICE_ACTION } from '@gphone/shared/rpc';

/**
 * The generic relay runs a contract's client hook before forwarding (MICA-213).
 *
 * `media:shareLocation` is `clientPrepared`: the server wants the street name at the
 * player's position, which only a client native can answer. That step used to be a private
 * `ServiceProxy` in `Location.ts` with its own NUI callback and its own reply subscription,
 * and the subscription was forgotten once. Now `Location.ts` registers a hook and the relay
 * that owns the subscription runs it — so what is asserted here is the join: the hook's
 * output is what reaches `emitNet`, an action that declares a hook but has none registered
 * is refused rather than forwarded, and an action that declares none passes through.
 *
 * Same manual-stub pattern as `ServiceProxy.test.ts`: the relay registers its callback at
 * import time, so the globals have to capture before the module loads.
 */
let nuiCallbacks: Map<string, (data: unknown, cb: Function) => unknown>;
let emitted: unknown[][];

const request = async (service: string, action: string, data?: unknown) => {
  const handler = nuiCallbacks.get(GENERIC_SERVICE_ACTION);
  if (!handler) throw new Error('the relay registered no generic callback');
  const cb = vi.fn();
  await handler({ service, action, data }, cb);
  return cb;
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  nuiCallbacks = new Map();
  emitted = [];
  const g = globalThis as Record<string, unknown>;
  g.RegisterNuiCallbackType = () => undefined;
  g.on = (event: string, handler: (data: unknown, cb: Function) => unknown) => {
    nuiCallbacks.set(event.replace('__cfx_nui:', ''), handler);
  };
  g.onNet = () => undefined;
  g.emitNet = (...args: unknown[]) => emitted.push(args);
  // The natives `Location.ts`'s hook reads, answering a fixed street.
  g.PlayerPedId = () => 1;
  g.GetEntityCoords = () => [215.3, -810.6, 30.7];
  g.GetStreetNameAtCoord = () => [0x1234, 0];
  g.GetStreetNameFromHashKey = () => 'Vespucci Boulevard';
  g.SetNewWaypoint = () => undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the generic relay and a contract client hook', () => {
  it('runs the registered hook and forwards what it returned', async () => {
    await import('../services/Location');
    await import('../services/Relay');

    const cb = await request('media', 'shareLocation', {});

    expect(cb).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
    const [event, , payload] = emitted[0] as [string, string, unknown];
    expect(event).toBe(requestEventFor('media', 'shareLocation'));
    expect(payload).toEqual({ label: 'Vespucci Boulevard' });
  });

  it('refuses a clientPrepared action that has no hook registered, and forwards nothing', async () => {
    // `Relay` alone: `Location.ts`, which registers the hook, is deliberately not loaded.
    await import('../services/Relay');

    const cb = await request('media', 'shareLocation', {});

    expect(emitted).toEqual([]);
    expect(cb).toHaveBeenCalledWith({
      error: expect.stringContaining('No client hook registered for media:shareLocation')
    });
  });

  it('forwards an action that declares no hook exactly as sent', async () => {
    await import('../services/Relay');

    await request('media', 'drop', { id: 7 });

    expect(emitted).toHaveLength(1);
    const [event, , payload] = emitted[0] as [string, string, unknown];
    expect(event).toBe(requestEventFor('media', 'drop'));
    expect(payload).toEqual({ id: 7 });
  });

  it('refuses a second hook for the same action', async () => {
    const { registerClientHook } = await import('../lib/clientHooks');
    registerClientHook('media', 'shareLocation', (d) => d);
    expect(() => registerClientHook('media', 'shareLocation', (d) => d)).toThrow(
      /already has a hook/
    );
  });
});
