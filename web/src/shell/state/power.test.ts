// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../../host/registerFacets';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { charge, chargeOf } from './charge';
import { setActiveDevice } from './device';
import { setMotionPreference } from './motion';
import { openDevice } from './phoneOpen';
import {
  BOOT_EXIT_MS,
  BOOT_IN_MS,
  BOOT_MIN_MS,
  BOOT_MS,
  OPEN_FLY_MS,
  POWER_OFF_MS,
  observePower,
  powerState
} from './power';
import { shellReady } from './shellReady';
import { callStore } from '../../services/call';

/**
 * MICA-236. When the boot and power-off screens play; how they look is
 * `BootScreen.test.ts`'s. Fake timers, because the point of half of these is that it ends.
 */

let stop: () => void;
const phase = () => get(powerState).phase;
const open = () => openDevice.set('phone');
const close = () => openDevice.set(null);
/** Raise a device as `Shell.svelte` does: it becomes the active one, and its frame is up. */
const raise = (device: 'phone' | 'tablet') => {
  setActiveDevice(device);
  openDevice.set(device);
};

beforeEach(() => {
  vi.useFakeTimers();
  openDevice.set(null);
  setActiveDevice('phone');
  chargeOf.phone.set(100);
  chargeOf.tablet.set(100);
  callStore.setStatus('idle');
  setMotionPreference('full');
  shellReady.set(false);
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

/**
 * MICA-450: a boot ends when the phone is ready, between a floor and a ceiling, and always
 * by fading out (`leaving`) rather than by cutting.
 */
describe('boot ends on readiness', () => {
  const leaving = () => get(powerState).leaving === true;

  it('keeps its floor and ceiling in an order that can hold', () => {
    expect(BOOT_MIN_MS).toBeGreaterThanOrEqual(BOOT_IN_MS);
    expect(BOOT_MIN_MS).toBeGreaterThanOrEqual(400);
    expect(BOOT_MIN_MS + BOOT_EXIT_MS).toBeLessThan(BOOT_MS);
  });

  it('holds for the minimum when ready before it, then fades out', () => {
    shellReady.set(true);
    open();
    vi.advanceTimersByTime(OPEN_FLY_MS + BOOT_MIN_MS - 1);
    expect(phase()).toBe('boot');
    expect(leaving()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(get(powerState)).toEqual({ phase: 'boot', delayMs: OPEN_FLY_MS, leaving: true });
    vi.advanceTimersByTime(BOOT_EXIT_MS - 1);
    expect(phase()).toBe('boot');
    vi.advanceTimersByTime(1);
    expect(phase()).toBe('idle');
  });

  it('ends as soon as it is ready when that comes after the minimum', () => {
    open();
    vi.advanceTimersByTime(OPEN_FLY_MS + BOOT_MIN_MS + 100);
    expect(leaving()).toBe(false);

    shellReady.set(true);
    expect(leaving()).toBe(true);
    vi.advanceTimersByTime(BOOT_EXIT_MS);
    expect(phase()).toBe('idle');
  });

  it('ends at the ceiling when readiness never comes, fade included', () => {
    open();
    vi.advanceTimersByTime(OPEN_FLY_MS + BOOT_MS - BOOT_EXIT_MS - 1);
    expect(leaving()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(leaving()).toBe(true);
    vi.advanceTimersByTime(BOOT_EXIT_MS);
    expect(phase()).toBe('idle');
  });

  it('is cancelled by a close before it is ready, and readiness later plays nothing', () => {
    open();
    vi.advanceTimersByTime(OPEN_FLY_MS + 100);
    close();
    expect(phase()).toBe('idle');

    shellReady.set(true);
    vi.advanceTimersByTime(5000);
    expect(phase()).toBe('idle');
    open();
    expect(phase()).toBe('idle');
  });

  it('does not restart its fade-out when readiness flickers mid-fade', () => {
    shellReady.set(true);
    open();
    vi.advanceTimersByTime(OPEN_FLY_MS + BOOT_MIN_MS + 100);
    shellReady.set(false);
    shellReady.set(true);
    vi.advanceTimersByTime(BOOT_EXIT_MS - 100);
    expect(phase()).toBe('idle');
  });

  it('runs a revival boot on a phone already ready for the minimum', () => {
    shellReady.set(true);
    open();
    vi.advanceTimersByTime(5000);
    charge.set(0);
    vi.advanceTimersByTime(5000);
    charge.set(30);
    expect(phase()).toBe('boot');
    vi.advanceTimersByTime(BOOT_MIN_MS + BOOT_EXIT_MS);
    expect(phase()).toBe('idle');
  });

  it('leaves the power-off screen on its own fixed time, ready or not', () => {
    shellReady.set(true);
    open();
    vi.advanceTimersByTime(5000);
    charge.set(0);
    vi.advanceTimersByTime(POWER_OFF_MS - 1);
    expect(get(powerState)).toEqual({ phase: 'off', delayMs: 0 });
    vi.advanceTimersByTime(1);
    expect(phase()).toBe('idle');
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

/** MICA-337: each device has a battery of its own, so each powers off and boots on its own. */
describe('per device', () => {
  it('treats switching from a dead phone to a charged tablet as an open, not a revival', () => {
    raise('phone');
    vi.advanceTimersByTime(5000);
    chargeOf.phone.set(0);
    expect(phase()).toBe('off');
    vi.advanceTimersByTime(5000);

    raise('tablet');
    expect(phase()).toBe('idle');
  });

  it('plays nothing on the open phone when the tablet dies or revives', () => {
    raise('phone');
    vi.advanceTimersByTime(5000);
    chargeOf.tablet.set(0);
    expect(phase()).toBe('idle');
    chargeOf.tablet.set(40);
    expect(phase()).toBe('idle');
  });

  it('powers the tablet off on its own battery, not the phone', () => {
    raise('tablet');
    vi.advanceTimersByTime(5000);
    chargeOf.phone.set(0);
    expect(phase()).toBe('idle');
    chargeOf.tablet.set(0);
    expect(get(powerState)).toEqual({ phase: 'off', delayMs: 0 });
  });

  it('boots a device on its next open when it revived while the other was up', () => {
    raise('tablet');
    vi.advanceTimersByTime(5000);
    chargeOf.tablet.set(0);
    vi.advanceTimersByTime(5000);

    raise('phone');
    chargeOf.tablet.set(30);
    expect(phase()).toBe('idle');
    vi.advanceTimersByTime(5000);

    raise('tablet');
    expect(get(powerState)).toEqual({ phase: 'boot', delayMs: OPEN_FLY_MS });
  });
});
