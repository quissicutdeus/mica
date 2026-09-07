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

import { isPhoneLocked, setPhoneLocked, __resetLockState } from '../lib/LockState';

describe('LockState (MICA-60)', () => {
  it('defaults to unlocked for a source never heard from', () => {
    expect(isPhoneLocked(999)).toBe(false);
  });

  it('reflects the last value set', () => {
    setPhoneLocked(1, true);
    expect(isPhoneLocked(1)).toBe(true);
    setPhoneLocked(1, false);
    expect(isPhoneLocked(1)).toBe(false);
  });

  it('is independent per source', () => {
    setPhoneLocked(2, true);
    expect(isPhoneLocked(3)).toBe(false);
  });

  it('clears a source on playerDropped, so the next player to take the slot starts unlocked', () => {
    setPhoneLocked(4, true);
    (globalThis as any).source = 4;
    const dropped = handlers.get('playerDropped');
    expect(dropped).toBeDefined();
    dropped!();
    expect(isPhoneLocked(4)).toBe(false);
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
    setPhoneLocked(1, true);
    expect(isPhoneLocked(1)).toBe(true);

    phoneOf.set(1, 'PHONE_B');
    expect(isPhoneLocked(1)).toBe(false);

    phoneOf.set(1, 'PHONE_A');
    expect(isPhoneLocked(1)).toBe(true);
  });

  it('a locked phone stays locked in another hand, and survives a disconnect', () => {
    phoneOf.set(1, 'PHONE_A');
    setPhoneLocked(1, true);

    (globalThis as any).source = 1;
    handlers.get('playerDropped')!();
    phoneOf.set(2, 'PHONE_A');

    expect(isPhoneLocked(2)).toBe(true);
  });

  it('unlocking one phone unlocks nothing else', () => {
    phoneOf.set(1, 'PHONE_A');
    phoneOf.set(2, 'PHONE_B');
    setPhoneLocked(1, true);
    setPhoneLocked(2, true);

    setPhoneLocked(1, false);

    expect(isPhoneLocked(1)).toBe(false);
    expect(isPhoneLocked(2)).toBe(true);
  });

  it('falls back to the source for a player who has not resolved a phone yet', () => {
    setPhoneLocked(5, true);
    expect(isPhoneLocked(5)).toBe(true);
    // The pre-283 behaviour: a source-keyed lock does not outlive the session.
    (globalThis as any).source = 5;
    handlers.get('playerDropped')!();
    expect(isPhoneLocked(5)).toBe(false);
  });
});
