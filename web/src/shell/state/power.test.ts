// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../../host/registerFacets';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { charge } from './charge';
import { setMotionPreference } from './motion';
import { openDevice } from './phoneOpen';
import { BOOT_MS, OPEN_FLY_MS, POWER_OFF_MS, observePower, powerState } from './power';
import { callStore } from '../../services/call';

/**
 * MICA-236. When the boot and power-off screens play; how they look is
 * `BootScreen.test.ts`'s. Fake timers, because the point of half of these is that it ends.
 */

let stop: () => void;
const phase = () => get(powerState).phase;
const open = () => openDevice.set('phone');
const close = () => openDevice.set(null);

beforeEach(() => {
  vi.useFakeTimers();
  openDevice.set(null);
  charge.set(100);
  callStore.setStatus('idle');
  setMotionPreference('full');
  stop = observePower();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe('boot', () => {
  it('plays on the first open of a session, after the frame has flown in, then ends', () => {
    expect(phase()).toBe('idle');
    open();
    expect(get(powerState)).toEqual({ phase: 'boot', delayMs: OPEN_FLY_MS });
    vi.advanceTimersByTime(OPEN_FLY_MS + BOOT_MS - 1);
    expect(phase()).toBe('boot');
    vi.advanceTimersByTime(1);
    expect(phase()).toBe('idle');
  });

  it('does not play again on a later open', () => {
    open();
    vi.advanceTimersByTime(5000);
    close();
    open();
    expect(phase()).toBe('idle');
  });

  it('is cancelled by closing the phone', () => {
    open();
    close();
    expect(phase()).toBe('idle');
  });

  it('plays when the battery comes back from dead, with no fly-in delay', () => {
    open();
    vi.advanceTimersByTime(5000);
    charge.set(0);
    vi.advanceTimersByTime(5000);
    charge.set(30);
    expect(get(powerState)).toEqual({ phase: 'boot', delayMs: 0 });
  });

  it('plays on the next open when it revived while the phone was closed', () => {
    open();
    vi.advanceTimersByTime(5000);
    charge.set(0);
    close();
    charge.set(30);
    expect(phase()).toBe('idle');
    open();
    expect(phase()).toBe('boot');
  });

  it('does not play for a phone opened already dead, but does once it revives', () => {
    charge.set(0);
    open();
    expect(phase()).toBe('idle');
    charge.set(10);
    expect(phase()).toBe('boot');
  });
});

describe('power-off', () => {
  it('plays when the battery dies while the phone is open, then ends', () => {
    open();
    vi.advanceTimersByTime(5000);
    charge.set(0);
    expect(get(powerState)).toEqual({ phase: 'off', delayMs: 0 });
    vi.advanceTimersByTime(POWER_OFF_MS);
    expect(phase()).toBe('idle');
  });

  it('does not play when the battery dies with the phone closed', () => {
    open();
    vi.advanceTimersByTime(5000);
    close();
    charge.set(0);
    expect(phase()).toBe('idle');
  });
});

describe('suppression', () => {
  it('plays nothing under reduced motion, and the first open is still spent', () => {
    setMotionPreference('reduced');
    open();
    expect(phase()).toBe('idle');
    setMotionPreference('full');
    close();
    open();
    expect(phase()).toBe('idle');
  });

  it('gives way to an incoming call, at the open and mid-boot', () => {
    callStore.setIncoming('555-0100', 'Ada');
    open();
    expect(phase()).toBe('idle');

    close();
    callStore.setStatus('idle');
    stop();
    stop = observePower();
    open();
    expect(phase()).toBe('boot');
    callStore.setIncoming('555-0100', 'Ada');
    expect(phase()).toBe('idle');
  });
});
