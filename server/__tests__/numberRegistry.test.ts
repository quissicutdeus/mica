// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { bridgeMock } = vi.hoisted(() => ({
  bridgeMock: { getPlayerByPhone: vi.fn(() => undefined), getPlayer: vi.fn() }
}));
vi.mock('../lib/FrameworkBridge', () => ({ FrameworkBridge: bridgeMock }));

import {
  registerNumber,
  unregisterNumber,
  lookupLine,
  __resetRegistry
} from '../lib/numberRegistry';

const onCall = () => ({ action: 'reject' }) as const;

describe('numberRegistry storage', () => {
  beforeEach(() => {
    __resetRegistry();
    bridgeMock.getPlayerByPhone.mockReturnValue(undefined);
  });

  it('registers a number and finds it again', () => {
    const result = registerNumber('5551234', { onCall }, 'taxi');
    expect(result.ok).toBe(true);
    expect(lookupLine('5551234')?.owner).toBe('taxi');
  });

  it('defaults blockable to true', () => {
    registerNumber('5551234', { onCall }, 'taxi');
    expect(lookupLine('5551234')?.blockable).toBe(true);
  });

  it('honours blockable false', () => {
    registerNumber('911', { onCall, blockable: false }, 'mica');
    expect(lookupLine('911')?.blockable).toBe(false);
  });

  it('refuses a number another resource already holds', () => {
    registerNumber('5551234', { onCall }, 'taxi');
    const second = registerNumber('5551234', { onCall }, 'mechanic');
    expect(second).toMatchObject({ ok: false, reason: 'already_registered' });
    expect(lookupLine('5551234')?.owner).toBe('taxi');
  });

  it('lets the same owner replace its own entry, so a script can hot-reload', () => {
    registerNumber('5551234', { onCall }, 'taxi');
    const again = registerNumber('5551234', { onCall, blockable: false }, 'taxi');
    expect(again.ok).toBe(true);
    expect(lookupLine('5551234')?.blockable).toBe(false);
  });

  it('refuses a number a real character already holds', () => {
    bridgeMock.getPlayerByPhone.mockReturnValue({
      source: 3,
      citizenid: 'ABC'
    });
    const result = registerNumber('5550100', { onCall }, 'taxi');
    expect(result).toMatchObject({ ok: false, reason: 'number_in_use' });
    expect(lookupLine('5550100')).toBeUndefined();
  });

  it('refuses a number that is not phone-number-shaped', () => {
    expect(registerNumber('', { onCall }, 'taxi')).toMatchObject({
      ok: false,
      reason: 'invalid_args'
    });
    expect(registerNumber('x'.repeat(33), { onCall }, 'taxi')).toMatchObject({
      ok: false,
      reason: 'invalid_args'
    });
  });

  it('refuses a registration with no callable onCall', () => {
    expect(registerNumber('5551234', {} as never, 'taxi')).toMatchObject({
      ok: false,
      reason: 'invalid_args'
    });
  });

  it('unregisters only for the owner', () => {
    registerNumber('5551234', { onCall }, 'taxi');
    expect(unregisterNumber('5551234', 'mechanic')).toMatchObject({
      ok: false,
      reason: 'not_owner'
    });
    expect(lookupLine('5551234')).toBeDefined();
    expect(unregisterNumber('5551234', 'taxi').ok).toBe(true);
    expect(lookupLine('5551234')).toBeUndefined();
  });

  it('reports unregistering a number nobody holds', () => {
    expect(unregisterNumber('5551234', 'taxi')).toMatchObject({
      ok: false,
      reason: 'invalid_args'
    });
  });
});
