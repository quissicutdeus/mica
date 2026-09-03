// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
// MICA-176: jsdom because this file's subjects transitively import `services/admin.ts`,
// which reads `window` at module scope. See `homeGridSettings.test.ts` for the reasoning.
/**
 * MICA-176: which facet set this file's subject resolves against — in-process, because a
 * unit test stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { DEVICES } from '@gphone/shared/devices';
import {
  activeDevice,
  descriptor,
  frame,
  perDevice,
  persistedKeyFor,
  setActiveDevice
} from './device';
import { homeGridColumns, homeGridRows } from './homeGridSettings';
import { homeGridItems } from './homeGrid';
import { dockAppIds, dockSlotCount, setDockSlot } from './dock';
import {
  displaySize,
  DISPLAY_SIZE_DEFAULT,
  phoneBox,
  shadeDragRevealDistance,
  viewportSize
} from './display';
import { currentApp, openApp, runningApps, closeAllApps } from './navigation';
import { appRegistryStore } from './registry';

/**
 * The shell is one device at a time, and everything that used to be the phone's own
 * number follows the active one (MICA-259).
 */
describe('the active device', () => {
  beforeEach(() => setActiveDevice('phone'));

  it('is the phone until told otherwise, and the descriptor and frame follow it', () => {
    expect(get(activeDevice)).toBe('phone');
    expect(get(descriptor)).toBe(DEVICES.phone);
    expect(get(frame)).toEqual({ width: 400, height: 850 });

    setActiveDevice('tablet');
    expect(get(descriptor)).toBe(DEVICES.tablet);
    expect(get(frame)).toEqual({ width: 1280, height: 800 });
  });

  it('sizes the sheets and the zoomed box from the frame, not from 850', () => {
    displaySize.set(DISPLAY_SIZE_DEFAULT);
    // Room for the whole range on either device, so the default lands on design size.
    viewportSize.set({ width: 2560, height: 1440 });
    expect(get(shadeDragRevealDistance)).toBe(850);
    expect(get(phoneBox)).toEqual({ width: 400, height: 850 });

    setActiveDevice('tablet');
    expect(get(shadeDragRevealDistance)).toBe(800);
    expect(get(phoneBox)).toEqual({ width: 1280, height: 800 });
  });

  it('is size-limited on a window the phone fits in with room to spare', () => {
    displaySize.set(100);
    viewportSize.set({ width: 1280, height: 960 });
    setActiveDevice('tablet');
    // 1280 wide needs 1312 with the small margin; the frame gives up zoom, never width.
    expect(get(phoneBox).width).toBeLessThan(1280);
    expect(get(phoneBox).width / get(phoneBox).height).toBeCloseTo(1280 / 800, 5);
  });
});

describe('a per-device setting', () => {
  beforeEach(() => setActiveDevice('phone'));

  it("keeps the phone's key and suffixes every other device's", () => {
    expect(persistedKeyFor('homeGridItems', 'phone')).toBe('homeGridItems');
    expect(persistedKeyFor('homeGridItems', 'tablet')).toBe('homeGridItems:tablet');
  });

  it('holds one value per device and follows the active one', () => {
    const setting = perDevice<number>(
      'device.test.example',
      (device) => device.launcher.columns,
      (value, device) => (typeof value === 'number' ? value : device.launcher.columns)
    );
    expect(get(setting)).toBe(4);
    setting.set(3);
    expect(get(setting)).toBe(3);

    setActiveDevice('tablet');
    expect(get(setting)).toBe(8);
    setting.update((n) => n + 1);
    expect(get(setting)).toBe(9);

    setActiveDevice('phone');
    expect(get(setting)).toBe(3);
  });

  it('gives the tablet its own launcher grid, dock and home-grid items', () => {
    homeGridItems.set([{ position: 0, kind: 'app', appId: 'notes' }]);
    expect(get(homeGridColumns)).toBe(DEVICES.phone.launcher.columns);
    expect(get(homeGridRows)).toBe(DEVICES.phone.launcher.rows);
    expect(get(dockSlotCount)).toBe(4);

    setActiveDevice('tablet');
    expect(get(homeGridColumns)).toBe(DEVICES.tablet.launcher.columns);
    expect(get(homeGridRows)).toBe(DEVICES.tablet.launcher.rows);
    expect(get(dockSlotCount)).toBe(6);
    expect(get(dockAppIds)).toEqual(['admin', 'settings', '', '', '', '']);
    expect(get(homeGridItems)).toEqual([]);

    // A write on the tablet clamps into the tablet's range and stays the tablet's.
    homeGridColumns.set(4);
    expect(get(homeGridColumns)).toBe(DEVICES.tablet.launcher.columnRange[0]);
    setDockSlot(5, 'mail');
    expect(get(dockAppIds)[5]).toBe('mail');

    setActiveDevice('phone');
    expect(get(homeGridColumns)).toBe(DEVICES.phone.launcher.columns);
    expect(get(dockAppIds)).toHaveLength(4);
    expect(get(homeGridItems)).toEqual([{ position: 0, kind: 'app', appId: 'notes' }]);
    homeGridItems.set([]);
  });
});

describe('navigation per device', () => {
  beforeEach(() => {
    setActiveDevice('phone');
    closeAllApps();
    vi.spyOn(appRegistryStore, 'isKnownApp').mockReturnValue(true);
    vi.spyOn(appRegistryStore, 'loadComponent').mockResolvedValue(undefined);
    // Every app runs on both devices here; the refusal itself is tested below.
    vi.spyOn(appRegistryStore, 'getManifest').mockImplementation(
      (id) => ({ id, devices: ['phone', 'tablet'] }) as never
    );
  });

  it('refuses an app the active device cannot show, and lets it through where it can (MICA-260)', () => {
    vi.spyOn(appRegistryStore, 'getManifest').mockImplementation((id) => ({ id }) as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    openApp('camera');
    expect(get(currentApp).id).toBe('camera');

    setActiveDevice('tablet');
    openApp('camera');
    expect(get(currentApp).id).toBe('home');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not run on the tablet'));

    vi.spyOn(appRegistryStore, 'getManifest').mockImplementation(
      (id) => ({ id, devices: ['tablet'] }) as never
    );
    openApp('admin');
    expect(get(currentApp).id).toBe('admin');
    warn.mockRestore();
  });

  it('stashes the resident apps and the screen when the device changes, and restores them', () => {
    openApp('notes');
    openApp('mail');
    expect(get(currentApp).id).toBe('mail');

    setActiveDevice('tablet');
    expect(get(currentApp).id).toBe('home');
    expect(get(runningApps)).toEqual([]);

    openApp('admin');
    setActiveDevice('phone');
    expect(get(currentApp).id).toBe('mail');
    expect(get(runningApps).map((a) => a.id)).toEqual(['notes', 'mail']);

    setActiveDevice('tablet');
    expect(get(currentApp).id).toBe('admin');
  });

  it('forgets every device on closeAllApps, not just the active one', () => {
    openApp('notes');
    setActiveDevice('tablet');
    openApp('admin');
    closeAllApps();
    setActiveDevice('phone');
    expect(get(runningApps)).toEqual([]);
    expect(get(currentApp).id).toBe('home');
  });
});
