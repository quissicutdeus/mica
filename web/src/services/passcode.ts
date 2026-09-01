// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';

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
 * PENDING (Cody): none of the four routes below (`shared/routes.ts`) have a server
 * `registerEvent` handler yet — no hashing, no `gphone_*` table. `web/src/nui/mocks/
 * registry.ts` is what answers them today.
 */
export const hasPasscode = writable(false);

export const refreshPasscodeStatus = async (): Promise<void> => {
  try {
    const reply = await fetchNui<{ hasPasscode?: boolean }>(
      'getPasscodeStatus',
      {},
      { defaultValue: { hasPasscode: false } }
    );
    hasPasscode.set(reply?.hasPasscode === true);
  } catch (e) {
    console.warn('Could not read passcode status; leaving the last known answer.', e);
  }
};

/** Set or replace the passcode. `digits` is 4 or 6 characters, `0`-`9` only. */
export const setPasscodeRemote = async (digits: string): Promise<void> => {
  await fetchNui('setPasscode', { passcode: digits });
  hasPasscode.set(true);
};

export const clearPasscodeRemote = async (): Promise<void> => {
  await fetchNui('clearPasscode', {});
  hasPasscode.set(false);
};

/** The one question the lock screen asks. Never throws on a wrong guess — only on a dead transport. */
export const checkPasscodeRemote = async (digits: string): Promise<boolean> => {
  const reply = await fetchNui<{ ok?: boolean }>('checkPasscode', { passcode: digits });
  return reply?.ok === true;
};
