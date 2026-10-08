// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
// `lockScreen.ts` reads a persisted setting at import, so this stands in for the shell.
import '../../host/registerFacets';
import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { appsOnScreen } from './appsOnScreen';
import { openDevice } from './phoneOpen';
import { isLocked } from './lockScreen';
import { charge } from './charge';

afterEach(() => {
  openDevice.set(null);
  isLocked.set(false);
  charge.set(100);
});

/**
 * MICA-294. The same two `{#if}`s `PhoneFrame.svelte` and `TabletFrame.svelte` wrap their
 * `children` in, restated as a store: if a frame changes what it draws instead of apps, this
 * table has to change with it.
 */
describe('appsOnScreen', () => {
  it('is false with no device open', () => {
    expect(get(appsOnScreen)).toBe(false);
  });

  it('is true with the phone or the tablet open', () => {
    openDevice.set('phone');
    expect(get(appsOnScreen)).toBe(true);
    openDevice.set('tablet');
    expect(get(appsOnScreen)).toBe(true);
  });

  it('is false under the lock screen on either device, since the tablet has one (MICA-264)', () => {
    isLocked.set(true);
    openDevice.set('phone');
    expect(get(appsOnScreen)).toBe(false);
    openDevice.set('tablet');
    expect(get(appsOnScreen)).toBe(false);
  });

  it('is false on either device with a dead battery', () => {
    charge.set(0);
    openDevice.set('phone');
    expect(get(appsOnScreen)).toBe(false);
    openDevice.set('tablet');
    expect(get(appsOnScreen)).toBe(false);
  });

  it('follows the phone being put away and brought back', () => {
    const seen: boolean[] = [];
    const off = appsOnScreen.subscribe((value) => seen.push(value));
    openDevice.set('phone');
    openDevice.set(null);
    openDevice.set('phone');
    off();
    expect(seen).toEqual([false, true, false, true]);
  });
});
