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
  __resetRegistry,
  type LineOptions
} from '../lib/numberRegistry';
import { askLine, HANDLER_TIMEOUT_MS } from '../lib/numberRegistry';
import { releaseResource, onLineReleased } from '../lib/numberRegistry';
import { linesForJob, LABEL_MAX } from '../lib/numberRegistry';

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

  it('leaves label and job null when a script gives neither', () => {
    registerNumber('5551234', { onCall }, 'taxi');
    expect(lookupLine('5551234')).toMatchObject({ label: null, job: null });
  });

  it('carries a label and a job through, trimmed', () => {
    registerNumber('5551234', { onCall, label: '  LSPD Dispatch ', job: 'police' }, 'lspd');
    expect(lookupLine('5551234')).toMatchObject({ label: 'LSPD Dispatch', job: 'police' });
  });

  it('refuses a label over the limit rather than cutting it short', () => {
    // A name cut short reads as a different name. Trimming happens before counting, so a
    // label padded over the limit is still fine.
    expect(
      registerNumber('5551234', { onCall, label: 'x'.repeat(LABEL_MAX + 1) }, 'lspd')
    ).toMatchObject({ ok: false, reason: 'invalid_args' });
    expect(lookupLine('5551234')).toBeUndefined();
    expect(
      registerNumber('5551234', { onCall, label: ' ' + 'x'.repeat(LABEL_MAX) + ' ' }, 'lspd').ok
    ).toBe(true);
  });

  it('refuses a label that is not a string, and treats a blank one as none', () => {
    expect(registerNumber('5551234', { onCall, label: 42 as never }, 'lspd')).toMatchObject({
      ok: false,
      reason: 'invalid_args'
    });
    registerNumber('5551234', { onCall, label: '   ' }, 'lspd');
    expect(lookupLine('5551234')?.label).toBeNull();
  });

  it.each(['Police', 'police dept', '1police', 'police-dept', '', 7])(
    'refuses %s as a job name',
    (job) => {
      // The same key every framework uses and every event segment is built from; a job that
      // does not match would never list under anything.
      expect(registerNumber('5551234', { onCall, job: job as never }, 'lspd')).toMatchObject({
        ok: false,
        reason: 'invalid_args'
      });
      expect(lookupLine('5551234')).toBeUndefined();
    }
  );

  it("lists a job's lines, and nobody else's", () => {
    registerNumber('5551111', { onCall, job: 'police', label: 'Dispatch' }, 'lspd');
    registerNumber('5552222', { onCall, job: 'police' }, 'lspd');
    registerNumber('5553333', { onCall, job: 'ambulance' }, 'ems');
    registerNumber('5554444', { onCall }, 'taxi');

    expect(
      linesForJob('police')
        .map((line) => line.number)
        .sort()
    ).toEqual(['5551111', '5552222']);
    expect(linesForJob('ambulance').map((line) => line.number)).toEqual(['5553333']);
    expect(linesForJob('taxi')).toEqual([]);
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

describe('numberRegistry handler invocation', () => {
  beforeEach(() => {
    __resetRegistry();
    bridgeMock.getPlayerByPhone.mockReturnValue(undefined);
  });

  const lineWith = (handler: LineOptions['onCall']) => {
    registerNumber('5551234', { onCall: handler }, 'taxi');
    return lookupLine('5551234')!;
  };

  const incoming = { from: '5550100', source: 3, callId: 42 };

  it('passes the call through and returns the verdict', async () => {
    const handler = vi.fn(() => ({ action: 'accept' }) as const);
    await expect(askLine(lineWith(handler), incoming)).resolves.toEqual({
      action: 'accept'
    });
    expect(handler).toHaveBeenCalledWith(incoming);
  });

  it('awaits an async handler', async () => {
    const handler = async () => ({ action: 'forward', source: 9 }) as const;
    await expect(askLine(lineWith(handler), incoming)).resolves.toEqual({
      action: 'forward',
      source: 9
    });
  });

  it('treats a throwing handler as a reject rather than propagating', async () => {
    const handler = () => {
      throw new Error('script bug');
    };
    await expect(askLine(lineWith(handler), incoming)).resolves.toEqual({
      action: 'reject'
    });
  });

  it('treats a rejected promise as a reject', async () => {
    const handler = async () => {
      throw new Error('async script bug');
    };
    await expect(askLine(lineWith(handler), incoming)).resolves.toEqual({
      action: 'reject'
    });
  });

  it('treats a verdict it does not recognise as a reject', async () => {
    const handler = () => ({ action: 'explode' }) as never;
    await expect(askLine(lineWith(handler), incoming)).resolves.toEqual({
      action: 'reject'
    });
  });

  it('rejects a forward whose source is not a number', async () => {
    const handler = () => ({ action: 'forward', source: 'nope' }) as never;
    await expect(askLine(lineWith(handler), incoming)).resolves.toEqual({
      action: 'reject'
    });
  });

  it('gives up on a handler that never returns', async () => {
    vi.useFakeTimers();
    const handler = () => new Promise<never>(() => {});
    const pending = askLine(lineWith(handler), incoming);
    await vi.advanceTimersByTimeAsync(HANDLER_TIMEOUT_MS + 1);
    await expect(pending).resolves.toEqual({ action: 'reject' });
    vi.useRealTimers();
  });

  it('treats a bare string verdict as a reject', async () => {
    const handler = () => 'ok' as never;
    await expect(askLine(lineWith(handler), incoming)).resolves.toEqual({
      action: 'reject'
    });
  });

  it('treats a null verdict as a reject', async () => {
    const handler = () => null as never;
    await expect(askLine(lineWith(handler), incoming)).resolves.toEqual({
      action: 'reject'
    });
  });

  it('treats an undefined verdict as a reject', async () => {
    const handler = () => undefined as never;
    await expect(askLine(lineWith(handler), incoming)).resolves.toEqual({
      action: 'reject'
    });
  });
});

describe('numberRegistry resource lifecycle', () => {
  beforeEach(() => {
    __resetRegistry();
    bridgeMock.getPlayerByPhone.mockReturnValue(undefined);
  });

  it("drops every number the stopping resource owned, and nobody else's", () => {
    registerNumber('5551111', { onCall }, 'taxi');
    registerNumber('5552222', { onCall }, 'taxi');
    registerNumber('5553333', { onCall }, 'mechanic');

    const dropped = releaseResource('taxi');

    expect(dropped.sort()).toEqual(['5551111', '5552222']);
    expect(lookupLine('5551111')).toBeUndefined();
    expect(lookupLine('5552222')).toBeUndefined();
    expect(lookupLine('5553333')).toBeDefined();
  });

  it('tells the call layer about each released number', () => {
    const released: string[] = [];
    onLineReleased((number) => released.push(number));
    registerNumber('5551111', { onCall }, 'taxi');

    releaseResource('taxi');

    expect(released).toEqual(['5551111']);
  });

  it('is a no-op for a resource that held nothing', () => {
    expect(releaseResource('unrelated')).toEqual([]);
  });
});
