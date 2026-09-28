// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: in-process, because a unit test stands in for the shell. The iframe twin's half
 * — `false` until the first push, and pinned to the frame's own id — is in
 * `iframe/facets/shellFacets.test.ts` and `IframeHostServer.test.ts`.
 */
import '../../web/src/host/registerFacets';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { useAppVisible } from './useAppVisible';
import { onAppForeground } from './lifecycle';
import { closeAllApps, currentApp, goHome, openApp } from '../../web/src/shell/state/navigation';
import { openDevice } from '../../web/src/shell/state/phoneOpen';
import { isLocked } from '../../web/src/shell/state/lockScreen';

beforeEach(() => {
  closeAllApps();
  currentApp.set({ id: 'home', props: {} });
  openDevice.set('phone');
  isLocked.set(false);
});

afterEach(() => {
  openDevice.set(null);
});

describe('useAppVisible (MICA-294)', () => {
  it('is true for the app in front of an open phone, and for no other app', () => {
    openApp('places');
    expect(get(useAppVisible('places'))).toBe(true);
    expect(get(useAppVisible('bank'))).toBe(false);
  });

  it('goes false when the phone is put away with the app still current, and back on reopen', () => {
    openApp('places');
    const seen: boolean[] = [];
    const off = useAppVisible('places').subscribe((v) => seen.push(v));

    openDevice.set(null);
    // The gap this exists for: nothing about the close touched `currentApp`.
    expect(get(currentApp).id).toBe('places');
    openDevice.set('phone');
    off();

    expect(seen).toEqual([true, false, true]);
  });

  it('where onAppForeground hears nothing at all across the same close and reopen', () => {
    openApp('places');
    const load = vi.fn();
    const off = onAppForeground('places', load);
    openDevice.set(null);
    openDevice.set('phone');
    off();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('goes false when the player leaves the app for home or another app', () => {
    openApp('places');
    const visible = useAppVisible('places');
    goHome();
    expect(get(visible)).toBe(false);
    openApp('notes');
    expect(get(visible)).toBe(false);
    openApp('places');
    expect(get(visible)).toBe(true);
  });

  it('works on the tablet, which has no lock screen to hide it', () => {
    openApp('places');
    isLocked.set(true);
    openDevice.set('tablet');
    expect(get(useAppVisible('places'))).toBe(true);
    openDevice.set('phone');
    expect(get(useAppVisible('places'))).toBe(false);
  });

  it('is case-insensitive about the app id, as openApp is', () => {
    openApp('places');
    expect(get(useAppVisible('Places'))).toBe(true);
  });
});
