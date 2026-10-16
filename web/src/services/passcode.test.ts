// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  ensurePasscodeAnswer,
  forgetPasscodeAnswer,
  hasPasscode,
  passcodeAnswerFor,
  refreshPasscodeStatus,
  setPasscodeRemote,
  clearPasscodeRemote
} from './passcode';
import * as fetchNuiModule from '../nui/fetchNui';

/**
 * A refused request, answered the way the real `fetchNui` answers one: the default when the
 * caller asked for one, a throw when it did not. A bare `mockRejectedValue` would skip the
 * defaulting entirely and pass against the very code this file exists to catch.
 */
function refuse<T>(_event: string, _data?: unknown, options?: { defaultValue?: T }): Promise<T> {
  return options?.defaultValue !== undefined
    ? Promise.resolve(options.defaultValue)
    : Promise.reject(new Error('Player not authenticated'));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('refreshPasscodeStatus', () => {
  it('takes the server answer', async () => {
    hasPasscode.set(false);
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ hasPasscode: true });

    await refreshPasscodeStatus();

    expect(get(hasPasscode)).toBe(true);
    expect(get(passcodeAnswerFor)).toBe('phone');
  });

  it('keeps a known passcode when a re-read fails, rather than unlocking the phone', async () => {
    hasPasscode.set(true);
    vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(refuse);

    await refreshPasscodeStatus();

    expect(get(hasPasscode)).toBe(true);
  });
});

describe('a failed first ask (MICA-385)', () => {
  it('starts unknown, and a failed ask leaves it unknown rather than "no passcode"', async () => {
    vi.resetModules();
    const fresh = await import('./passcode');
    const transport = await import('../nui/fetchNui');
    // Nobody has asked yet, so nobody knows.
    expect(get(fresh.passcodeAnswerFor)).toBeNull();
    vi.spyOn(transport, 'fetchNui').mockImplementation(refuse);

    await fresh.refreshPasscodeStatus();

    expect(get(fresh.passcodeAnswerFor)).toBeNull();
  });
});

describe('ensurePasscodeAnswer', () => {
  it('asks nothing when the active device already has an answer', async () => {
    passcodeAnswerFor.set('phone');
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui');

    await ensurePasscodeAnswer();

    expect(spy).not.toHaveBeenCalled();
  });

  it('joins an ask already out instead of sending a second', async () => {
    forgetPasscodeAnswer();
    let reply: (value: { hasPasscode: boolean }) => void = () => {};
    const spy = vi
      .spyOn(fetchNuiModule, 'fetchNui')
      .mockImplementation(() => new Promise((resolve) => (reply = resolve as never)));

    const first = refreshPasscodeStatus();
    const second = ensurePasscodeAnswer();
    reply({ hasPasscode: false });
    await Promise.all([first, second]);

    expect(spy).toHaveBeenCalledOnce();
    expect(get(passcodeAnswerFor)).toBe('phone');
  });
});

describe('a set or clear reply that lands after a forget (MICA-385)', () => {
  /** The transport, held open until the test answers. */
  const deferred = () => {
    let reply: (value: unknown) => void = () => {};
    vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(
      () => new Promise((resolve) => (reply = resolve as never))
    );
    return (value: unknown) => reply(value);
  };

  it('drops a late "cleared" rather than lifting the new identity\'s lock', async () => {
    passcodeAnswerFor.set('phone');
    hasPasscode.set(true);
    const answer = deferred();
    const cleared = clearPasscodeRemote();

    // The previous character's clear is still out when the next one loads.
    forgetPasscodeAnswer();
    answer({ ok: true });
    await cleared;

    expect(get(passcodeAnswerFor)).toBeNull();
  });

  it('drops a late "set" the same way', async () => {
    passcodeAnswerFor.set('phone');
    hasPasscode.set(false);
    const answer = deferred();
    const set = setPasscodeRemote('1234');

    forgetPasscodeAnswer();
    answer({ ok: true });
    await set;

    expect(get(passcodeAnswerFor)).toBeNull();
    expect(get(hasPasscode)).toBe(false);
  });
});
