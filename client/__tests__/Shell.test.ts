// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The server's `openApp` push against the owner's disabled-app list (MICA-234).
 *
 * The client half is UX: the server refuses a disabled app's events and the shell hides its
 * tile whatever happens here. What is pinned is that this handler does not raise the device
 * onto an app the owner switched off, and that an unreadable convar refuses nothing.
 */
const { handlers, sent } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const g = globalThis as Record<string, unknown>;
  const previousOnNet = g.onNet;
  g.onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previousOnNet === 'function' ? previousOnNet(event, handler) : undefined;
  };
  const messages: { action: string; data: any }[] = [];
  g.SendNuiMessage = (payload: string) => messages.push(JSON.parse(payload));
  g.TriggerServerEvent = () => {};
  g.SetNuiFocus = () => {};
  g.PlayerPedId = () => 7;
  g.GetClockHours = () => 9;
  g.GetClockMinutes = () => 30;
  return { handlers: captured, sent: messages };
});
vi.mock('../game/DeviceAnimation', () => ({
  DeviceAnimation: { playIdle: vi.fn(), spawnProp: vi.fn(), removeProp: vi.fn(), stopAll: vi.fn() }
}));
vi.mock('../game/PhoneCamera', () => ({ PhoneCamera: { disable: vi.fn(), enable: vi.fn() } }));
vi.mock('../game/Freelook', () => ({ Freelook: { resetFreelook: vi.fn() } }));
vi.mock('../services/Battery', () => ({ sendChargeToNui: vi.fn() }));
vi.mock('../services/DeviceItem', () => ({ requestDeviceItemCheck: vi.fn() }));

import '../services/Shell';
import { DeviceState } from '../lib/DeviceState';

const g = globalThis as Record<string, unknown>;
const originalGetConvar = g.GetConvar;
const withDisabled = (value: string) => {
  g.GetConvar = (name: string, fallback: string) =>
    name === 'mica_disabled_apps' ? value : fallback;
};
const fire = (event: string, payload?: unknown) => handlers.get(event)!(payload);
const openApp = (payload: unknown) => fire('mica:client:shell:openApp', payload);

beforeEach(() => {
  sent.length = 0;
  DeviceState.__reset();
});

afterEach(() => {
  g.GetConvar = originalGetConvar;
});

describe('mica:client:shell:openApp and mica_disabled_apps', () => {
  it('refuses a listed app silently, without raising the device', () => {
    withDisabled('contacts,bank');
    openApp({ appId: 'contacts', props: { contactId: 4 } });
    expect(DeviceState.isOpen('phone')).toBe(false);
    expect(sent).toEqual([]);
  });

  it('refuses the deep-link shape of a listed app too', () => {
    withDisabled('contacts');
    openApp({ appId: 'mica://Contacts?contactId=4' });
    expect(DeviceState.isOpen('phone')).toBe(false);
    expect(sent).toEqual([]);
  });

  it('opens an app the list does not name', () => {
    withDisabled('bank');
    openApp({ appId: 'contacts', props: { contactId: 4 } });
    expect(DeviceState.isOpen('phone')).toBe(true);
    expect(sent.at(-1)).toEqual({
      action: 'openApp',
      data: { appId: 'contacts', props: { contactId: 4 }, device: 'phone' }
    });
  });

  it('refuses nothing when the convar is unset, missing or unreadable', () => {
    // Unset, or set with `set` rather than `setr`: the fallback comes back.
    openApp({ appId: 'contacts' });
    expect(DeviceState.isOpen('phone')).toBe(true);

    for (const stub of [
      undefined,
      () => {
        throw new Error('no convars here');
      }
    ]) {
      DeviceState.__reset();
      sent.length = 0;
      g.GetConvar = stub;
      openApp({ appId: 'contacts' });
      expect(DeviceState.isOpen('phone')).toBe(true);
      expect(sent.at(-1)?.action).toBe('openApp');
    }
  });

  it('never refuses opening the device itself', () => {
    withDisabled('contacts,bank,messages');
    fire('mica:client:shell:open');
    expect(DeviceState.isOpen('phone')).toBe(true);
  });
});
