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

const phoneOf = vi.hoisted(() => new Map<number, string>());
vi.mock('../services/Phones', () => ({
  activePhoneIdOf: (src: number) => phoneOf.get(src) ?? null
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
 * MICA-263: the tablet has no identity until MICA-264, so its lock is keyed on the session
 * holding it — never on the phone id, which would make locking a tablet lock the phone.
 */
describe('LockState per device (MICA-263)', () => {
  beforeEach(() => {
    __resetLockState();
    phoneOf.clear();
  });

  it('keeps the tablet and the phone apart, with or without a resolved phone', () => {
    setDeviceLocked(1, 'tablet', true);
    expect(isDeviceLocked(1, 'tablet')).toBe(true);
    expect(isDeviceLocked(1, 'phone')).toBe(false);

    phoneOf.set(1, 'PHONE_A');
    setDeviceLocked(1, 'phone', true);
    setDeviceLocked(1, 'tablet', false);
    expect(isDeviceLocked(1, 'phone')).toBe(true);
    expect(isDeviceLocked(1, 'tablet')).toBe(false);
  });

  it('does not follow the phone: a switch leaves the tablet lock where it was', () => {
    phoneOf.set(1, 'PHONE_A');
    setDeviceLocked(1, 'tablet', true);
    phoneOf.set(1, 'PHONE_B');
    expect(isDeviceLocked(1, 'tablet')).toBe(true);
    // Nor does a tablet lock land on the phone another player now holds.
    phoneOf.set(2, 'PHONE_A');
    expect(isDeviceLocked(2, 'phone')).toBe(false);
  });

  it("clears the tablet lock on playerDropped, and only that source's", () => {
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
