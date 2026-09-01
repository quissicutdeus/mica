// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';

const handlers = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  (globalThis as any).on = (event: string, handler: Function) => {
    captured.set(event, handler);
  };
  return captured;
});

import { isPhoneLocked, setPhoneLocked } from '../lib/LockState';

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
