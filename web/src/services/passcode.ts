// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get, writable } from 'svelte/store';
import { call } from '../nui/call';
import { lockscreenContract } from '@mica/shared/contracts/lockscreen';
import type { DeviceId } from '@mica/shared/devices';
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
 * Starts as `null` — nobody knows yet — and becomes a device only when the server answers
 * for it (MICA-385). Unknown locks (`evaluateLockOnOpen`), so a phone opened before the
 * answer lands shows the lock screen, and `lockScreen.ts` lifts it the moment the answer is
 * "no passcode" — in the dev browser that is the mock's reply a tick after mount.
 *
 * It used to start as the phone's "no passcode", and a failed ask recorded that as the
 * answer. `Shell.svelte`'s mount-time ask is refused before any character exists
 * (MICA-266), so a fresh connect opened unlocked for the whole session. A failed ask with no
 * real answer in hand now leaves it unknown, and a character load asks again
 * (`state/deviceIdentity.ts`).
 */
export const passcodeAnswerFor = writable<DeviceId | null>(null);

/**
 * The device the server has actually answered for, as against the page-load assumption
 * above. Module state, not a store: only the failure path reads it.
 */
let answeredFor: DeviceId | null = null;

/**
 * Bumped by every forget, so a reply to an ask sent before it is dropped on arrival rather
 * than recorded as the answer for whoever is behind the device now — a character load's
 * forget, with the previous character's ask still out, would otherwise take that answer as
 * the new character's.
 */
let generation = 0;

/** The ask in flight, if any, and which device and generation it is for. */
let inFlight: { device: DeviceId; generation: number; promise?: Promise<void> } | null = null;

/**
 * Called by a device switch or a character load: the answer on hand is somebody else's, so
 * it is no answer.
 */
export const forgetPasscodeAnswer = (): void => {
  generation += 1;
  answeredFor = null;
  hasPasscode.set(false);
  passcodeAnswerFor.set(null);
};

/**
 * Ask whether the active device has a passcode. An answer that lands after the player has
 * already moved to the other device, or after the answer was forgotten, is dropped rather
 * than applied. Callers that overlap for the same device and generation share one request.
 */
export const refreshPasscodeStatus = (): Promise<void> => {
  const device = get(activeDevice);
  const asked = generation;
  if (inFlight?.promise && inFlight.device === device && inFlight.generation === asked) {
    return inFlight.promise;
  }
  const entry: NonNullable<typeof inFlight> = { device, generation: asked };
  inFlight = entry;
  entry.promise = (async () => {
    try {
      // `call`, not `callOr`: a defaulted `{ hasPasscode: false }` never reached the catch
      // below, so a failed re-read cleared a real passcode instead of leaving it.
      const reply = await call(lockscreenContract, 'status', undefined, { device });
      if (get(activeDevice) !== device || generation !== asked) return;
      answeredFor = device;
      hasPasscode.set(reply?.hasPasscode === true);
      passcodeAnswerFor.set(device);
    } catch (e) {
      // A real answer for this device stays. Without one the device is unknown, which locks:
      // it used to be recorded as answered with no passcode, and that is how a fresh connect
      // opened unlocked for a whole session (MICA-385).
      console.warn('Could not read passcode status; leaving the last known answer.', e);
      if (get(activeDevice) !== device || generation !== asked) return;
      if (answeredFor !== device) passcodeAnswerFor.set(null);
    } finally {
      if (inFlight === entry) inFlight = null;
    }
  })();
  return entry.promise;
};

/**
 * Ask only when the active device's answer is unknown; share an ask already out.
 *
 * What an open calls when it finds no answer (`evaluateLockOnOpen`). Without it a failed ask
 * was never repeated: a player with no passcode was locked out on every open, with the
 * emergency button — a real 911 call — as the only way past.
 */
export const ensurePasscodeAnswer = (): Promise<void> =>
  get(passcodeAnswerFor) === get(activeDevice) ? Promise.resolve() : refreshPasscodeStatus();

/** Set or replace the passcode. `digits` is 4 or 6 characters, `0`-`9` only. */
export const setPasscodeRemote = async (digits: string): Promise<void> => {
  const device = get(activeDevice);
  const asked = generation;
  await call(lockscreenContract, 'set', { passcode: digits }, { device });
  // A reply after a forget is the previous identity's write, not an answer for this one.
  if (get(activeDevice) !== device || generation !== asked) return;
  answeredFor = device;
  hasPasscode.set(true);
  passcodeAnswerFor.set(device);
};

export const clearPasscodeRemote = async (): Promise<void> => {
  const device = get(activeDevice);
  const asked = generation;
  await call(lockscreenContract, 'clear', undefined, { device });
  // Above all here: a late "cleared" taken as the new identity's answer would lift its lock.
  if (get(activeDevice) !== device || generation !== asked) return;
  answeredFor = device;
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
