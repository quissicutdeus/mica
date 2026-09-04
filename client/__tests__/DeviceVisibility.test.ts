// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEVICES } from '@mica/shared/devices';

/**
 * The open/close sequence, per device (MICA-262). The game-side pieces it drives are
 * spies — the prop, the animation, the scripted camera and freelook each have their own
 * file — and the FiveM globals are the manual stubs `Call.test.ts` uses.
 */
const { animation, camera, freelook, battery } = vi.hoisted(() => ({
  animation: { playIdle: vi.fn(), spawnProp: vi.fn(), removeProp: vi.fn(), stopAll: vi.fn() },
  camera: { disable: vi.fn() },
  freelook: { resetFreelook: vi.fn() },
  battery: { sendChargeToNui: vi.fn() }
}));
vi.mock('../game/DeviceAnimation', () => ({ DeviceAnimation: animation }));
vi.mock('../game/PhoneCamera', () => ({ PhoneCamera: camera }));
vi.mock('../game/Freelook', () => ({ Freelook: freelook }));
vi.mock('../services/Battery', () => battery);

let sent: { action: string; data: unknown }[];
let focus: unknown[][];
const g = globalThis as Record<string, unknown>;
g.TriggerServerEvent = () => {};
g.SetNuiFocus = (...args: unknown[]) => focus.push(args);
g.SendNuiMessage = (payload: string) => sent.push(JSON.parse(payload));
g.PlayerPedId = () => 7;
g.GetClockHours = () => 9;
g.GetClockMinutes = () => 30;

import { DeviceState } from '../lib/DeviceState';
import { openDevice, closeDevice, closeOpenDevice } from '../lib/DeviceVisibility';

const visible = () => sent.filter((m) => m.action === 'setVisible').map((m) => m.data);

describe('DeviceVisibility', () => {
  beforeEach(() => {
    sent = [];
    focus = [];
    vi.clearAllMocks();
    DeviceState.__reset();
  });

  it('raises a device: state, focus, the frame, its own prop and idle, time and charge', () => {
    openDevice('phone');

    expect(DeviceState.openDevice()).toBe('phone');
    expect(focus).toEqual([[true, true]]);
    expect(visible()).toEqual([{ device: 'phone', visible: true }]);
    expect(animation.playIdle).toHaveBeenCalledWith(7, DEVICES.phone);
    expect(animation.spawnProp).toHaveBeenCalledWith(7, DEVICES.phone);
    expect(sent.some((m) => m.action === 'setTime')).toBe(true);
    expect(battery.sendChargeToNui).toHaveBeenCalledTimes(1);
  });

  it('lowers the other device first, so one frame is ever up', () => {
    openDevice('phone');
    sent = [];
    openDevice('tablet');

    expect(visible()).toEqual([
      { device: 'phone', visible: false },
      { device: 'tablet', visible: true }
    ]);
    expect(DeviceState.isOpen('phone')).toBe(false);
    expect(DeviceState.openDevice()).toBe('tablet');
    expect(animation.spawnProp).toHaveBeenLastCalledWith(7, DEVICES.tablet);
  });

  it('puts the scripted camera down with the phone and never for the tablet', () => {
    openDevice('phone');
    closeDevice('phone');
    expect(camera.disable).toHaveBeenCalledTimes(1);
    expect(animation.removeProp).toHaveBeenCalledTimes(1);
    expect(animation.stopAll).toHaveBeenCalledWith(7);
    expect(freelook.resetFreelook).toHaveBeenCalledTimes(1);

    openDevice('tablet');
    closeDevice('tablet');
    expect(camera.disable).toHaveBeenCalledTimes(1);
    expect(visible().at(-1)).toEqual({ device: 'tablet', visible: false });
  });

  it('closeOpenDevice lowers whichever is up and is a no-op when nothing is', () => {
    closeOpenDevice();
    expect(visible()).toEqual([]);

    openDevice('tablet');
    closeOpenDevice();
    expect(DeviceState.isAnyOpen()).toBe(false);
    expect(visible().at(-1)).toEqual({ device: 'tablet', visible: false });
  });
});
