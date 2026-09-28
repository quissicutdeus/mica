// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { bridgeMock, netHandlers, dropHandlers } = vi.hoisted(() => {
  const net: Record<string, Function> = {};
  const drop: Function[] = [];
  (globalThis as any).onNet = (event: string, handler: Function) => {
    net[event] = handler;
  };
  (globalThis as any).on = (event: string, handler: Function) => {
    if (event === 'playerDropped') drop.push(handler);
  };
  return {
    bridgeMock: { getPlayer: vi.fn() },
    netHandlers: net,
    dropHandlers: drop
  };
});
vi.mock('../lib/FrameworkBridge', () => ({ FrameworkBridge: bridgeMock }));

import { __resetOpenState, isDeviceOpen } from '../lib/PhoneOpenState';

const SRC = 11;

/**
 * There is no synchronous way to ask a client whether the phone is open — see the
 * module's own doc comment — so this is fed by a fire-and-forget push and answers from
 * whatever it last heard. These assertions drive that push directly.
 */
describe('PhoneOpenState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetOpenState();
    (globalThis as any).source = SRC;
    bridgeMock.getPlayer.mockReturnValue({ citizenid: 'ABC12345' });
  });

  it('defaults to closed for a source never heard from', () => {
    expect(isDeviceOpen(999, 'phone')).toBe(false);
  });

  it('remembers what the client last pushed', () => {
    netHandlers['mica:server:shell:setOpen'](true);
    expect(isDeviceOpen(SRC, 'phone')).toBe(true);

    netHandlers['mica:server:shell:setOpen'](false);
    expect(isDeviceOpen(SRC, 'phone')).toBe(false);
  });

  it('reads the device-shaped push the client sends since MICA-262, per device (MICA-263)', () => {
    netHandlers['mica:server:shell:setOpen']({ device: 'tablet', open: true });
    expect(isDeviceOpen(SRC, 'tablet')).toBe(true);
    expect(isDeviceOpen(SRC, 'phone')).toBe(false);

    netHandlers['mica:server:shell:setOpen']({ device: 'phone', open: true });
    expect(isDeviceOpen(SRC, 'phone')).toBe(true);

    netHandlers['mica:server:shell:setOpen']({ device: 'tablet', open: false });
    expect(isDeviceOpen(SRC, 'tablet')).toBe(false);
    expect(isDeviceOpen(SRC, 'phone')).toBe(true);

    netHandlers['mica:server:shell:setOpen']({ device: 'phone' });
    expect(isDeviceOpen(SRC, 'phone')).toBe(false);
  });

  it('drops a device that is not one, never recording it as the phone', () => {
    netHandlers['mica:server:shell:setOpen']({ device: 'watch', open: true });
    expect(isDeviceOpen(SRC, 'phone')).toBe(false);
  });

  it('ignores a push from a source with no loaded character', () => {
    bridgeMock.getPlayer.mockReturnValue(undefined);
    netHandlers['mica:server:shell:setOpen'](true);
    expect(isDeviceOpen(SRC, 'phone')).toBe(false);
  });

  it('forgets a source when it drops, so the next player does not inherit it', () => {
    netHandlers['mica:server:shell:setOpen'](true);
    netHandlers['mica:server:shell:setOpen']({ device: 'tablet', open: true });
    (globalThis as any).source = SRC + 1;
    netHandlers['mica:server:shell:setOpen'](true);
    expect(isDeviceOpen(SRC, 'phone')).toBe(true);

    (globalThis as any).source = SRC;
    for (const handler of dropHandlers) handler();
    expect(isDeviceOpen(SRC, 'phone')).toBe(false);
    expect(isDeviceOpen(SRC, 'tablet')).toBe(false);
    // Another source whose id starts with the same digits is untouched.
    expect(isDeviceOpen(SRC + 1, 'phone')).toBe(true);
  });
});
