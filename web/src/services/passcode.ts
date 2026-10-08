// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get, writable } from 'svelte/store';
import { call, callOr } from '../nui/call';
import { lockscreenContract } from '@mica/shared/contracts/lockscreen';
import { DEFAULT_DEVICE, type DeviceId } from '@mica/shared/devices';
import { activeDevice } from '../shell/state/device';

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
 * `web/src/nui/mocks/services/lockscreen.ts` answers them under `'lockscreen:<action>'` in
 * a browser.
 */
export const hasPasscode = writable(false);

/**
 * Which device `hasPasscode` answers for, or `null` while nobody knows (MICA-264).
 *
 * The passcode is per device, so the answer is too, and one that belongs to the phone says
 * nothing about the tablet. A device switch clears this (`forgetPasscodeAnswer`) before it
 * asks again, and `evaluateLockOnOpen` treats an answer for another device as no answer —
 * otherwise the tablet would open unlocked, or locked, on the phone's.
 *
 * Starts as the phone's, which is what the shell has always assumed at page load: `false`
 * until `Shell.svelte`'s mount asks, with the whole time before first open to answer.
 */
export const passcodeAnswerFor = writable<DeviceId | null>(DEFAULT_DEVICE);

/** Called by a device switch: the answer on hand is the other device's, so it is no answer. */
export const forgetPasscodeAnswer = (): void => {
  hasPasscode.set(false);
  passcodeAnswerFor.set(null);
};

/**
 * Ask whether the active device has a passcode. An answer that lands after the player has
 * already moved to the other device is dropped rather than applied to it.
 */
export const refreshPasscodeStatus = async (): Promise<void> => {
  const device = get(activeDevice);
  try {
    const reply = await callOr(
      lockscreenContract,
      'status',
      undefined,
      { hasPasscode: false },
      { device }
    );
    if (get(activeDevice) !== device) return;
    hasPasscode.set(reply?.hasPasscode === true);
    passcodeAnswerFor.set(device);
  } catch (e) {
    console.warn('Could not read passcode status; leaving the last known answer.', e);
    // The lock is a display state, not a boundary (above): a device whose answer could not
    // be read is treated as having none, rather than locked behind a passcode nobody can
    // check — which is what it did before the answer was per device, too.
    if (get(activeDevice) === device) passcodeAnswerFor.set(device);
  }
};

/** Set or replace the passcode. `digits` is 4 or 6 characters, `0`-`9` only. */
export const setPasscodeRemote = async (digits: string): Promise<void> => {
  const device = get(activeDevice);
  await call(lockscreenContract, 'set', { passcode: digits }, { device });
  if (get(activeDevice) !== device) return;
  hasPasscode.set(true);
  passcodeAnswerFor.set(device);
};

export const clearPasscodeRemote = async (): Promise<void> => {
  const device = get(activeDevice);
  await call(lockscreenContract, 'clear', undefined, { device });
  if (get(activeDevice) !== device) return;
  hasPasscode.set(false);
  passcodeAnswerFor.set(device);
};

/**
 * The one question the lock screen asks. Never throws on a wrong guess — only on a dead
 * transport. Unstamped on purpose: the lock screen on screen is the active device's.
 */
export const checkPasscodeRemote = async (digits: string): Promise<boolean> => {
  const reply = await call(lockscreenContract, 'check', { passcode: digits });
  return reply?.ok === true;
};
