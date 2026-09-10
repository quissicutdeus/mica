// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The client export surface (MICA-224), pinned the way `server/__tests__/exports.test.ts`
 * pins the server's: the names are a contract, every one answers an outcome rather than
 * throwing, and the ones that share a name with a server export share its meaning.
 */
const { animation, camera, freelook, battery, itemCheck, bridge } = vi.hoisted(() => ({
  animation: { playIdle: vi.fn(), spawnProp: vi.fn(), removeProp: vi.fn(), stopAll: vi.fn() },
  camera: { disable: vi.fn(), enable: vi.fn() },
  freelook: { resetFreelook: vi.fn() },
  battery: { sendChargeToNui: vi.fn() },
  itemCheck: { requestDeviceItemCheck: vi.fn() },
  bridge: { number: null as string | null }
}));
vi.mock('../game/DeviceAnimation', () => ({ DeviceAnimation: animation }));
vi.mock('../game/PhoneCamera', () => ({ PhoneCamera: camera }));
vi.mock('../game/Freelook', () => ({ Freelook: freelook }));
vi.mock('../services/Battery', () => battery);
vi.mock('../services/DeviceItem', () => itemCheck);
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: { getPhoneNumber: () => bridge.number }
}));

let sent: { action: string; data: any }[];
const g = globalThis as Record<string, unknown>;
g.TriggerServerEvent = () => {};
g.SetNuiFocus = () => {};
g.SendNuiMessage = (payload: string) => sent.push(JSON.parse(payload));
g.PlayerPedId = () => 7;
g.GetClockHours = () => 9;
g.GetClockMinutes = () => 30;

import { DeviceState } from '../lib/DeviceState';
import {
  registerClientApi,
  publishedClientExport,
  publishedClientExports,
  MICA_CLIENT_API_VERSION
} from '../lib/publicApi';

const call = (name: string, ...args: unknown[]) =>
  (publishedClientExport(name) as Function)(...args) as any;

beforeEach(() => {
  sent = [];
  vi.clearAllMocks();
  bridge.number = '555-0100';
  DeviceState.__reset();
  registerClientApi();
});

describe('the client export surface', () => {
  it('publishes exactly the documented names', () => {
    // Adding one here is a deliberate act. Removing or renaming one breaks a caller.
    expect(publishedClientExports()).toEqual([
      'ClosePhone',
      'GetApiVersion',
      'GetPhoneNumber',
      'IsPhoneOpen',
      'Notify',
      'OpenApp',
      'OpenPhone',
      'SetPhoneEnabled',
      'TogglePhone'
    ]);
  });

  it('reports a version a caller can branch on', () => {
    expect(call('GetApiVersion')).toEqual({ ok: true, value: MICA_CLIENT_API_VERSION });
  });

  it('never throws across the boundary', () => {
    for (const name of publishedClientExports()) {
      expect(() => call(name, undefined, undefined), name).not.toThrow();
      // Symbols are the one thing `String()` chokes on inside a template; a guard that
      // let that through would take the caller's script down with it.
      expect(() => call(name, Symbol('x'), Symbol('y')), name).not.toThrow();
    }
  });

  it('refuses a device that is not one, rather than defaulting to the phone', () => {
    const result = call('IsPhoneOpen', 'fridge');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_args');
    // And omitting it is the phone.
    expect(call('IsPhoneOpen')).toEqual({ ok: true, value: false });
  });
});

describe('open, close and toggle', () => {
  it('opens as the key would and reports it open', () => {
    expect(call('OpenPhone')).toEqual({ ok: true, value: undefined });
    expect(DeviceState.isOpen('phone')).toBe(true);
    expect(call('IsPhoneOpen').value).toBe(true);
    expect(sent.some((m) => m.action === 'setVisible' && m.data.visible === true)).toBe(true);
  });

  it('puts a disabled device down and refuses to raise it, with a reason that says so', () => {
    call('OpenPhone');
    expect(call('SetPhoneEnabled', false)).toEqual({ ok: true, value: undefined });
    expect(DeviceState.isOpen('phone')).toBe(false);

    const refused = call('OpenPhone');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('disabled');
    // Closing is always allowed, disabled or not.
    expect(call('ClosePhone').ok).toBe(true);

    call('SetPhoneEnabled', true);
    expect(call('OpenPhone').ok).toBe(true);
  });

  it('requires a boolean to enable or disable', () => {
    expect(call('SetPhoneEnabled', 'yes').reason).toBe('invalid_args');
    expect(DeviceState.isEnabled('phone')).toBe(true);
  });

  it('toggles exactly as the key does and answers the state afterwards', () => {
    expect(call('TogglePhone')).toEqual({ ok: true, value: { open: true } });
    expect(call('TogglePhone')).toEqual({ ok: true, value: { open: false } });
  });

  it('a toggle against a disabled device asks the server to look at the inventory again', () => {
    call('SetPhoneEnabled', false);
    expect(call('TogglePhone')).toEqual({ ok: true, value: { open: false } });
    expect(itemCheck.requestDeviceItemCheck).toHaveBeenCalledTimes(1);
  });

  it('does nothing while a text field has focus, the way the key does not', () => {
    DeviceState.setTyping(true);
    expect(call('TogglePhone').value).toEqual({ open: false });
  });
});

describe('the rest', () => {
  it('reads the phone number the framework has, and says when there is none yet', () => {
    expect(call('GetPhoneNumber')).toEqual({ ok: true, value: '555-0100' });
    bridge.number = null;
    expect(call('GetPhoneNumber').reason).toBe('not_ready');
  });

  it('opens the device on an app and hands the shell the props', () => {
    expect(call('OpenApp', 'Contacts', { contactId: 4 })).toEqual({ ok: true, value: undefined });
    expect(DeviceState.isOpen('phone')).toBe(true);
    expect(sent.at(-1)).toEqual({
      action: 'openApp',
      data: { appId: 'contacts', props: { contactId: 4 }, device: 'phone' }
    });
  });

  it('refuses an app id that is not one, and a disabled device', () => {
    expect(call('OpenApp', 'not an app').reason).toBe('invalid_args');
    call('SetPhoneEnabled', false);
    expect(call('OpenApp', 'contacts').reason).toBe('disabled');
    expect(sent.some((m) => m.action === 'openApp')).toBe(false);
  });

  describe('an app the owner disabled (MICA-234)', () => {
    const originalGetConvar = g.GetConvar;
    const withDisabled = (value: string) => {
      g.GetConvar = (name: string, fallback: string) =>
        name === 'mica_disabled_apps' ? value : fallback;
    };
    afterEach(() => {
      g.GetConvar = originalGetConvar;
    });

    it('is refused with app_disabled, and the device is not raised', () => {
      withDisabled('bank, Contacts');
      const refused = call('OpenApp', 'contacts', { contactId: 4 });
      expect(refused).toMatchObject({ ok: false, reason: 'app_disabled' });
      expect(DeviceState.isOpen('phone')).toBe(false);
      expect(sent).toEqual([]);
    });

    it('answers app_disabled ahead of disabled, since no player state brings it back', () => {
      withDisabled('contacts');
      call('SetPhoneEnabled', false);
      expect(call('OpenApp', 'contacts').reason).toBe('app_disabled');
    });

    it('opens an app the list does not name', () => {
      withDisabled('bank');
      expect(call('OpenApp', 'contacts')).toEqual({ ok: true, value: undefined });
      expect(sent.at(-1)?.action).toBe('openApp');
    });

    it('refuses nothing when the convar is unset, missing or unreadable', () => {
      // Unset, or set with `set` rather than `setr`: the fallback comes back.
      expect(call('OpenApp', 'contacts').ok).toBe(true);
      g.GetConvar = undefined;
      expect(call('OpenApp', 'contacts').ok).toBe(true);
      g.GetConvar = () => {
        throw new Error('no convars here');
      };
      expect(call('OpenApp', 'contacts').ok).toBe(true);
    });
  });

  it('raises a toast and nothing more', () => {
    expect(call('Notify', { type: 'success', title: 'Lockpick', message: 'Door open' }).ok).toBe(
      true
    );
    expect(sent.at(-1)).toEqual({
      action: 'notify',
      data: { type: 'success', title: 'Lockpick', message: 'Door open' }
    });
    expect(call('Notify', { title: 'no body' }).reason).toBe('invalid_args');
    expect(call('Notify', 'Door open').reason).toBe('invalid_args');
  });
});
