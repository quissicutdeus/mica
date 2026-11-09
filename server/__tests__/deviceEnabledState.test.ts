// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Every `on` handler this module registers, in order — not one slot per event, since another
 * module's `playerDropped` would take the slot.
 */
const dropHandlers = vi.hoisted(() => {
  const handlers: Function[] = [];
  const previousOn = (globalThis as any).on;
  (globalThis as any).on = (event: string, handler: Function) => {
    if (event === 'playerDropped') handlers.push(handler);
    return typeof previousOn === 'function' ? previousOn(event, handler) : undefined;
  };
  return handlers;
});

import {
  __resetDeviceEnabledState,
  isDeviceConfiscated,
  recordDeviceEnabled
} from '../lib/DeviceEnabledState';

const drop = (src: number) => {
  (globalThis as any).source = src;
  for (const handler of dropHandlers) handler();
};

beforeEach(() => {
  __resetDeviceEnabledState();
});

/** What `SetPhoneEnabled` last said, kept per source and device (MICA-474). */
describe('DeviceEnabledState', () => {
  it('answers not confiscated for a source never heard from', () => {
    expect(isDeviceConfiscated(4, 'phone')).toBe(false);
  });

  it('keeps each device apart, and returns one when told', () => {
    recordDeviceEnabled(4, 'tablet', false);
    expect([isDeviceConfiscated(4, 'phone'), isDeviceConfiscated(4, 'tablet')]).toEqual([
      false,
      true
    ]);

    recordDeviceEnabled(4, 'phone', false);
    recordDeviceEnabled(4, 'tablet', true);
    expect([isDeviceConfiscated(4, 'phone'), isDeviceConfiscated(4, 'tablet')]).toEqual([
      true,
      false
    ]);
  });

  it('forgets every device of a source that drops, and only theirs', () => {
    recordDeviceEnabled(4, 'phone', false);
    recordDeviceEnabled(4, 'tablet', false);
    recordDeviceEnabled(40, 'phone', false);
    expect(dropHandlers).toHaveLength(1);

    drop(4);

    // A reused id starts with its phone back; source 40 shares a prefix and keeps its own.
    expect(isDeviceConfiscated(4, 'phone')).toBe(false);
    expect(isDeviceConfiscated(4, 'tablet')).toBe(false);
    expect(isDeviceConfiscated(40, 'phone')).toBe(true);
  });
});
