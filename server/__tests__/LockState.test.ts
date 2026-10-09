// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  (globalThis as any).on = (event: string, handler: Function) => {
    captured.set(event, handler);
  };
  return captured;
});

const { phoneOf, tabletOf } = vi.hoisted(() => ({
  phoneOf: new Map<number, string>(),
  tabletOf: new Map<number, string>()
}));
vi.mock('../services/Devices', () => ({
  activeDeviceIdOf: (src: number, kind: string) =>
    (kind === 'phone' ? phoneOf : tabletOf).get(src) ?? null
}));

import { isDeviceLocked, setDeviceLocked, __resetLockState } from '../lib/LockState';

describe('LockState (MICA-60)', () => {
  it('defaults to unlocked for a source never heard from', () => {
    expect(isDeviceLocked(999, 'phone')).toBe(false);
  });

  it('reflects the last value set', () => {
    setDeviceLocked(1, 'phone', true);
    expect(isDeviceLocked(1, 'phone')).toBe(true);
    setDeviceLocked(1, 'phone', false);
    expect(isDeviceLocked(1, 'phone')).toBe(false);
  });

  it('is independent per source', () => {
    setDeviceLocked(2, 'phone', true);
    expect(isDeviceLocked(3, 'phone')).toBe(false);
  });

  it('clears a source on playerDropped, so the next player to take the slot starts unlocked', () => {
    setDeviceLocked(4, 'phone', true);
    (globalThis as any).source = 4;
    const dropped = handlers.get('playerDropped');
    expect(dropped).toBeDefined();
    dropped!();
    expect(isDeviceLocked(4, 'phone')).toBe(false);
  });
});

/**
 * MICA-283: the lock is the phone's. A burner picked up locked stays locked, in whoever's
 * hand it lands, and unlocking one phone unlocks nothing else.
 */
describe('LockState follows the phone (MICA-283)', () => {
  beforeEach(() => {
    __resetLockState();
    phoneOf.clear();
  });

  it('keys the lock on the phone in hand, so a switch switches the lock', () => {
    phoneOf.set(1, 'PHONE_A');
    setDeviceLocked(1, 'phone', true);
    expect(isDeviceLocked(1, 'phone')).toBe(true);

    phoneOf.set(1, 'PHONE_B');
    expect(isDeviceLocked(1, 'phone')).toBe(false);

    phoneOf.set(1, 'PHONE_A');
    expect(isDeviceLocked(1, 'phone')).toBe(true);
  });

  it('a locked phone stays locked in another hand, and survives a disconnect', () => {
    phoneOf.set(1, 'PHONE_A');
    setDeviceLocked(1, 'phone', true);

    (globalThis as any).source = 1;
    handlers.get('playerDropped')!();
    phoneOf.set(2, 'PHONE_A');

    expect(isDeviceLocked(2, 'phone')).toBe(true);
  });

  it('unlocking one phone unlocks nothing else', () => {
    phoneOf.set(1, 'PHONE_A');
    phoneOf.set(2, 'PHONE_B');
    setDeviceLocked(1, 'phone', true);
    setDeviceLocked(2, 'phone', true);

    setDeviceLocked(1, 'phone', false);

    expect(isDeviceLocked(1, 'phone')).toBe(false);
    expect(isDeviceLocked(2, 'phone')).toBe(true);
  });

  it('falls back to the source for a player who has not resolved a phone yet', () => {
    setDeviceLocked(5, 'phone', true);
    expect(isDeviceLocked(5, 'phone')).toBe(true);
    // The pre-283 behaviour: a source-keyed lock does not outlive the session.
    (globalThis as any).source = 5;
    handlers.get('playerDropped')!();
    expect(isDeviceLocked(5, 'phone')).toBe(false);
  });
});

/**
 * MICA-263 kept the tablet's lock apart from the phone's; since MICA-264 it follows the
 * tablet's own id, as the phone's follows the phone's, and falls back to the session holding
 * it before the tablet has resolved one.
 */
describe('LockState per device (MICA-263, MICA-264)', () => {
  beforeEach(() => {
    __resetLockState();
    phoneOf.clear();
    tabletOf.clear();
  });

  it('keeps the tablet and the phone apart, with or without a resolved device', () => {
    setDeviceLocked(1, 'tablet', true);
    expect(isDeviceLocked(1, 'tablet')).toBe(true);
    expect(isDeviceLocked(1, 'phone')).toBe(false);

    phoneOf.set(1, 'PHONE_A');
    setDeviceLocked(1, 'phone', true);
    setDeviceLocked(1, 'tablet', false);
    expect(isDeviceLocked(1, 'phone')).toBe(true);
    expect(isDeviceLocked(1, 'tablet')).toBe(false);

    tabletOf.set(1, 'TABLET_A');
    setDeviceLocked(1, 'tablet', true);
    expect(isDeviceLocked(1, 'tablet')).toBe(true);
    expect(isDeviceLocked(1, 'phone')).toBe(true);
    setDeviceLocked(1, 'phone', false);
    expect(isDeviceLocked(1, 'tablet')).toBe(true);
  });

  it('does not follow the phone: a phone switch leaves the tablet lock where it was', () => {
    phoneOf.set(1, 'PHONE_A');
    setDeviceLocked(1, 'tablet', true);
    phoneOf.set(1, 'PHONE_B');
    expect(isDeviceLocked(1, 'tablet')).toBe(true);
    // Nor does a tablet lock land on the phone another player now holds.
    phoneOf.set(2, 'PHONE_A');
    expect(isDeviceLocked(2, 'phone')).toBe(false);
  });

  it('follows the tablet in hand (MICA-264): a tablet switch switches its lock', () => {
    tabletOf.set(1, 'TABLET_A');
    setDeviceLocked(1, 'tablet', true);

    tabletOf.set(1, 'TABLET_B');
    expect(isDeviceLocked(1, 'tablet')).toBe(false);

    tabletOf.set(1, 'TABLET_A');
    expect(isDeviceLocked(1, 'tablet')).toBe(true);
  });

  it('a locked tablet stays locked in another hand, and survives a disconnect (MICA-264)', () => {
    tabletOf.set(1, 'TABLET_A');
    setDeviceLocked(1, 'tablet', true);

    (globalThis as any).source = 1;
    handlers.get('playerDropped')!();
    tabletOf.set(2, 'TABLET_A');

    expect(isDeviceLocked(2, 'tablet')).toBe(true);
    // And it is not the phone's, whatever phone that player holds.
    phoneOf.set(2, 'PHONE_A');
    expect(isDeviceLocked(2, 'phone')).toBe(false);
  });

  it("clears an unresolved tablet's lock on playerDropped, and only that source's", () => {
    setDeviceLocked(4, 'tablet', true);
    setDeviceLocked(44, 'tablet', true);
    setDeviceLocked(4, 'phone', true);

    (globalThis as any).source = 4;
    handlers.get('playerDropped')!();

    expect(isDeviceLocked(4, 'tablet')).toBe(false);
    expect(isDeviceLocked(4, 'phone')).toBe(false);
    expect(isDeviceLocked(44, 'tablet')).toBe(true);
  });
});
