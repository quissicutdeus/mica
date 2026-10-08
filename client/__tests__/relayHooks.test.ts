// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { requestEventFor, GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';

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

const request = async (service: string, action: string, data?: unknown, device?: unknown) => {
  const handler = nuiCallbacks.get(GENERIC_SERVICE_ACTION);
  if (!handler) throw new Error('the relay registered no generic callback');
  const cb = vi.fn();
  await handler(
    device === undefined ? { service, action, data } : { service, action, data, device },
    cb
  );
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
  // `DeviceState.setOpen` tells the server; nothing here listens.
  g.TriggerServerEvent = () => undefined;
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

/**
 * Which device a request speaks for (MICA-264). The server reads it as the event's third
 * argument and checks it, so what is asserted here is only what the client sends: the page's
 * own word first, then the device on screen, then the phone.
 */
describe('the relay names the device a request speaks for', () => {
  const deviceOf = (index = 0) => (emitted[index] as unknown[])[3];

  it('forwards the device the generic request named', async () => {
    const { DeviceState } = await import('../lib/DeviceState');
    await import('../services/Relay');
    DeviceState.setOpen('phone', true);

    await request('media', 'drop', { id: 7 }, 'tablet');

    expect(deviceOf()).toBe('tablet');
  });

  it('falls back to the open device when the generic request names none', async () => {
    const { DeviceState } = await import('../lib/DeviceState');
    await import('../services/Relay');
    DeviceState.setOpen('tablet', true);

    await request('media', 'drop', { id: 7 });

    expect(deviceOf()).toBe('tablet');
  });

  it('falls back to the phone when no device is open', async () => {
    await import('../services/Relay');

    await request('media', 'drop', { id: 7 });

    expect(deviceOf()).toBe('phone');
  });

  it('refuses a generic request naming a device that is not ours, and forwards nothing', async () => {
    await import('../services/Relay');

    const cb = await request('media', 'drop', { id: 7 }, 'pager');

    expect(emitted).toEqual([]);
    expect(cb).toHaveBeenCalledWith({ error: 'Malformed service request' });
  });

  it('sends the open device on a named route, read at request time', async () => {
    const { DeviceState } = await import('../lib/DeviceState');
    const { ROUTES, serverEventFor } = await import('@mica/shared/routes');
    await import('../services/Relay');
    const route = ROUTES[0];
    const handler = nuiCallbacks.get(route.action);
    if (!handler) throw new Error(`no NUI callback for route ${route.action}`);

    handler({}, vi.fn());
    DeviceState.setOpen('tablet', true);
    handler({}, vi.fn());

    expect(emitted.map((args) => [args[0], args[3]])).toEqual([
      [serverEventFor(route), 'phone'],
      [serverEventFor(route), 'tablet']
    ]);
  });
});
