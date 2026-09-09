// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  charge,
  roundedCharge,
  displayCharge,
  isBatteryDead,
  stepBatteryWarning,
  NO_BATTERY_WARNINGS_FIRED
} from './charge';
import { get } from 'svelte/store';

describe('charge store', () => {
  it('initializes charge to 100', () => {
    charge.set(100);
    expect(get(charge)).toBe(100);
    expect(get(roundedCharge)).toBe(100);
    expect(get(displayCharge)).toBe(100);
    expect(get(isBatteryDead)).toBe(false);
  });

  it('updates charge state', () => {
    charge.set(75);
    expect(get(charge)).toBe(75);
    expect(get(roundedCharge)).toBe(75);
    expect(get(displayCharge)).toBe(75);
    expect(get(isBatteryDead)).toBe(false);
  });

  it('calculates roundedCharge and displayCharge correctly for floating point battery levels', () => {
    charge.set(45.678);
    expect(get(roundedCharge)).toBe(45.68);
    expect(get(displayCharge)).toBe(46);
    expect(get(isBatteryDead)).toBe(false);
  });

  it('uses Math.ceil for displayCharge so non-zero battery shows as 1%', () => {
    charge.set(0.49);
    expect(get(displayCharge)).toBe(1);
    expect(get(isBatteryDead)).toBe(false);
  });

  it('flags battery as dead when charge drops to 0 or below', () => {
    charge.set(0);
    expect(get(displayCharge)).toBe(0);
    expect(get(isBatteryDead)).toBe(true);

    charge.set(-5);
    expect(get(roundedCharge)).toBe(0);
    expect(get(displayCharge)).toBe(0);
    expect(get(isBatteryDead)).toBe(true);
  });
});

describe('low-battery warning arming (MICA-193)', () => {
  const armed = NO_BATTERY_WARNINGS_FIRED;

  it('fires 20 once on the way down and not again below it', () => {
    const at20 = stepBatteryWarning(armed, 20, false);
    expect(at20.due).toBe(20);
    expect(at20.fired).toEqual({ 20: true, 5: false });
    expect(stepBatteryWarning(at20.fired, 19, false).due).toBeNull();
    expect(stepBatteryWarning(at20.fired, 6, false).due).toBeNull();
  });

  it('fires 5 separately, once', () => {
    const { fired } = stepBatteryWarning(armed, 20, false);
    const at5 = stepBatteryWarning(fired, 5, false);
    expect(at5.due).toBe(5);
    expect(at5.fired).toEqual({ 20: true, 5: true });
    expect(stepBatteryWarning(at5.fired, 1, false).due).toBeNull();
  });

  it('re-arms a threshold once the level rises back above it', () => {
    const both = { 20: true, 5: true };
    const at10 = stepBatteryWarning(both, 10, false);
    expect(at10.due).toBeNull();
    expect(at10.fired).toEqual({ 20: true, 5: false });
    const at50 = stepBatteryWarning(at10.fired, 50, false);
    expect(at50.fired).toEqual(armed);
    expect(stepBatteryWarning(at50.fired, 20, false).due).toBe(20);
  });

  it('does nothing above both thresholds', () => {
    expect(stepBatteryWarning(armed, 21, false)).toEqual({ fired: armed, due: null });
  });

  it('holds a due warning while blocked and fires it once unblocked', () => {
    const locked = stepBatteryWarning(armed, 15, true);
    expect(locked.due).toBeNull();
    expect(locked.fired).toEqual(armed);
    expect(stepBatteryWarning(locked.fired, 15, false).due).toBe(20);
  });

  it('reports only the lowest threshold when both come due at once', () => {
    const plunge = stepBatteryWarning(armed, 4, false);
    expect(plunge.due).toBe(5);
    expect(plunge.fired).toEqual({ 20: true, 5: true });
  });

  it('neither fires nor re-arms on a dead battery', () => {
    const both = { 20: true, 5: true };
    expect(stepBatteryWarning(both, 0, true)).toEqual({ fired: both, due: null });
    expect(stepBatteryWarning(armed, 0, true)).toEqual({ fired: armed, due: null });
  });
});
