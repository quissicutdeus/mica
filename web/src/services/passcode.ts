// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import { call, callOr } from '../nui/call';
import { lockscreenContract } from '@gphone/shared/contracts/lockscreen';

/**
 * The lock screen's passcode, entirely server-side (MICA-60).
 *
 * **Display state, not a security boundary** — the ticket's own reading, item 4: nothing
 * behind the lock is authority-bearing, so a modified client that skips this file gains
 * nothing it did not already have. What that buys here is the freedom to keep verification
 * simple: the server is asked "is this the passcode?" and answers yes or no, rather than
 * this file holding anything to compare against. The passcode itself is never written to
 * `usePersisted`/browser storage — only the boolean "is one set" is cached here, and that
 * cache is a convenience for the Settings UI, not a source of truth Chrome's dev tools could
 * read a passcode out of.
 *
 * All four actions are declared in `shared/contracts/lockscreen.ts` and reached through the
 * typed `call` over the generic service action (MICA-213), so none of them needs a row in
 * `shared/routes.ts`; `server/services/Lockscreen.ts` answers them, and
 * `web/src/nui/mocks/registry.ts` answers them under `'lockscreen:<action>'` in a browser.
 */
export const hasPasscode = writable(false);

export const refreshPasscodeStatus = async (): Promise<void> => {
  try {
    const reply = await callOr(lockscreenContract, 'status', undefined, {
      hasPasscode: false
    });
    hasPasscode.set(reply?.hasPasscode === true);
  } catch (e) {
    console.warn('Could not read passcode status; leaving the last known answer.', e);
  }
};

/** Set or replace the passcode. `digits` is 4 or 6 characters, `0`-`9` only. */
export const setPasscodeRemote = async (digits: string): Promise<void> => {
  await call(lockscreenContract, 'set', { passcode: digits });
  hasPasscode.set(true);
};

export const clearPasscodeRemote = async (): Promise<void> => {
  await call(lockscreenContract, 'clear', undefined);
  hasPasscode.set(false);
};

/** The one question the lock screen asks. Never throws on a wrong guess — only on a dead transport. */
export const checkPasscodeRemote = async (digits: string): Promise<boolean> => {
  const reply = await call(lockscreenContract, 'check', { passcode: digits });
  return reply?.ok === true;
};
