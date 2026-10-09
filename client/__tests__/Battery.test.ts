// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The client half of the battery, per device (MICA-337). It only paints what the server
 * pushes, so the suite drives the two net events and the debug NUI callback `Battery.ts`
 * registers at import, and reads what reached the UI and the server.
 *
 * Manual stubs captured per import, the pattern `Call.test.ts` uses.
 */

let netHandlers: Map<string, (...args: any[]) => void>;
let nuiHandlers: Map<string, (data: any, cb: Function) => void>;
let triggered: unknown[][];
let sent: { action: string; data: any }[];
let removePlayerFromCall: ReturnType<typeof vi.fn>;

const g = globalThis as Record<string, unknown>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  netHandlers = new Map();
  nuiHandlers = new Map();
  triggered = [];
  sent = [];
  removePlayerFromCall = vi.fn();

  g.onNet = (name: string, fn: (...args: any[]) => void) => netHandlers.set(name, fn);
  g.on = (name: string, fn: (data: any, cb: Function) => void) => nuiHandlers.set(name, fn);
  g.RegisterNuiCallbackType = () => {};
  g.TriggerServerEvent = (...args: unknown[]) => triggered.push(args);
  g.SendNuiMessage = (payload: string) => sent.push(JSON.parse(payload));
  g.exports = { 'pma-voice': { removePlayerFromCall } };

  battery = await import('../services/Battery');
});

let battery: typeof import('../services/Battery');

const set = (...args: unknown[]) => netHandlers.get('mica:client:battery:set')!(...args);
const charging = (...args: unknown[]) => netHandlers.get('mica:client:battery:charging')!(...args);
const charges = () => sent.filter((m) => m.action === 'setCharge').map((m) => m.data);
const chargingMessages = () => sent.filter((m) => m.action === 'setCharging').map((m) => m.data);
const phoneEnds = () => triggered.filter((t) => t[0] === 'mica:server:phone:end');

/** Read back each device's held level through the re-sync `openDevice` uses. */
const held = (device: 'phone' | 'tablet') => {
  sent = [];
  battery.sendChargeToNui(device);
  return charges()[0];
};

describe('battery:set', () => {
  it('a set with no device goes to the phone', () => {
    set(42);
    expect(charges()).toEqual([{ device: 'phone', level: 42 }]);
    expect(held('phone')).toEqual({ device: 'phone', level: 42 });
    expect(held('tablet')).toEqual({ device: 'tablet', level: 100 });
  });

  it("a tablet set does not touch the phone's level", () => {
    set(60);
    set(15, 'tablet');
    expect(held('tablet')).toEqual({ device: 'tablet', level: 15 });
    expect(held('phone')).toEqual({ device: 'phone', level: 60 });
  });

  it('refuses a device that is not one, rather than defaulting it to the phone', () => {
    set(60);
    sent = [];
    set(3, 'watch');
    expect(charges()).toEqual([]);
    expect(held('phone')).toEqual({ device: 'phone', level: 60 });
  });
});

describe('a device that dies', () => {
  it('a dead phone ends the call through the server, not pma-voice', () => {
    set(1);
    set(0);
    expect(phoneEnds()).toHaveLength(1);
    // The server leaves the channel on `phone:end` (MICA-341); the client never asks pma-voice.
    expect(removePlayerFromCall).not.toHaveBeenCalled();
    expect(sent).toContainEqual({ action: 'callStatus', data: { status: 'idle' } });
  });

  it('a dead tablet never reaches the phone: no call ended, no frame lowered', () => {
    set(1, 'tablet');
    set(0, 'tablet');
    expect(phoneEnds()).toEqual([]);
    expect(removePlayerFromCall).not.toHaveBeenCalled();
    expect(sent.some((m) => m.action === 'callStatus')).toBe(false);
    expect(sent.some((m) => m.action === 'setVisible')).toBe(false);
    expect(held('phone')).toEqual({ device: 'phone', level: 100 });
  });
});

describe('battery:charging', () => {
  it('is held and forwarded per device, absent meaning the phone', () => {
    charging(true, 'tablet');
    expect(chargingMessages()).toEqual([{ device: 'tablet', charging: true }]);

    sent = [];
    battery.sendChargeToNui('phone');
    expect(chargingMessages()).toEqual([{ device: 'phone', charging: false }]);

    sent = [];
    charging(true);
    battery.sendChargeToNui('tablet');
    expect(chargingMessages()).toEqual([
      { device: 'phone', charging: true },
      { device: 'tablet', charging: true }
    ]);
  });
});

describe('setBatteryLevel (debug NUI callback)', () => {
  const call = (data: unknown) => {
    const cb = vi.fn();
    nuiHandlers.get('__cfx_nui:setBatteryLevel')!(data, cb);
    return cb.mock.calls[0]![0];
  };
  const adminSets = () => triggered.filter((t) => t[0] === 'mica:server:admin:setBattery');

  it('keeps the one-argument tuple for the phone', () => {
    expect(call({ level: 30 })).toEqual({ ok: true, level: 30, device: 'phone' });
    expect(adminSets()).toEqual([['mica:server:admin:setBattery', 30]]);
  });

  it('names a tablet, and leaves the phone alone', () => {
    expect(call({ level: 30, device: 'tablet' })).toEqual({
      ok: true,
      level: 30,
      device: 'tablet'
    });
    expect(adminSets()).toEqual([['mica:server:admin:setBattery', 30, 'tablet']]);
    expect(held('phone')).toEqual({ device: 'phone', level: 100 });
  });

  it('refuses a bad device or level and tells the server nothing', () => {
    expect(call({ level: 30, device: 'watch' })).toEqual({ ok: false });
    expect(call({ level: 'x' })).toEqual({ ok: false });
    expect(adminSets()).toEqual([]);
  });
});
