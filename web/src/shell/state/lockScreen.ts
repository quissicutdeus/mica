// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable, get } from 'svelte/store';
import { usePersisted } from '../../../../sdk/host/usePersisted';
import { DEVICES, type DeviceId } from '@mica/shared/devices';
import { ensurePasscodeAnswer, hasPasscode, passcodeAnswerFor } from '../../services/passcode';
import { activeDevice } from './device';
import { openDevice } from './phoneOpen';

/**
 * Lock-screen display state (MICA-60), scoped exactly as the ticket's item 4 reads it:
 * "the lock is a display state, not a security boundary." Nothing behind it is
 * authority-bearing, and nothing server-side is gated on `isLocked` — it only decides what
 * `PhoneFrame.svelte` paints on open, the same kind of decision `isBatteryDead` already
 * makes there.
 */

import type { AutoLockPolicy, AutoLockPolicyChoice } from '../../../../sdk/vocabulary/shell';

export const AUTO_LOCK_POLICY_CHOICES: readonly AutoLockPolicyChoice[] = [
  {
    id: 'onClose',
    label: 'On Close',
    description: 'Ask for the passcode every time the device is opened.'
  },
  {
    id: 'onTimeout',
    label: 'On Timeout',
    description: 'Only ask after the device has been closed for a few minutes.'
  },
  { id: 'never', label: 'Never', description: 'Skip the lock screen entirely.' }
];

const sanitizePolicy = (value: unknown): AutoLockPolicy =>
  value === 'onTimeout' || value === 'never' ? value : 'onClose';

export const autoLockPolicy = usePersisted<AutoLockPolicy>(
  'settings',
  'auto_lock_policy',
  'onClose',
  { sanitize: sanitizePolicy }
);

export const setAutoLockPolicy = (policy: AutoLockPolicy): void => {
  // The player's own choice, made now, is this identity's by definition.
  policyUnconfirmed = false;
  autoLockPolicy.set(sanitizePolicy(policy));
};

/**
 * Whether the saved auto-lock policy may still be the previous identity's.
 *
 * A character load or device switch sweeps settings to the new identity's rows, but a failed
 * sweep returns early and leaves the old ones (`hydrateSettingsOnCharacterLoad`) — so a
 * previous character's `'never'` would carry over to one who has a passcode. Until a sweep
 * succeeds the lock reads the strict default, `'onClose'`, instead.
 *
 * A flag the evaluation reads rather than a write of `'onClose'` into `autoLockPolicy`: that
 * store's `set` persists and queues a server save, and the sweep skips any key with a write
 * still pending — so the reset would have been saved as the new character's choice and their
 * real row never applied.
 */
let policyUnconfirmed = false;

/** A character load or device switch: the policy on hand may not be this identity's. */
export const distrustLockPolicy = (): number => {
  policyUnconfirmed = true;
  return ++policyGeneration;
};

/**
 * Bumped by every distrust, so a sweep that finishes after a later identity change cannot
 * vouch for the policy: it applied the previous identity's rows, not the current one's.
 */
let policyGeneration = 0;

/** The new identity's settings have been applied, so the saved policy is theirs. */
export const trustLockPolicy = (generation?: number): void => {
  if (generation !== undefined && generation !== policyGeneration) return;
  policyUnconfirmed = false;
};

/** How long the phone has to sit closed before `'onTimeout'` locks it on the next open. */
export const AUTO_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Whether the lock screen is the thing the frame on screen should paint right now —
 * `PhoneFrame.svelte` or, since MICA-264 gave it an identity to lock, `TabletFrame.svelte`.
 */
export const isLocked = writable(false);

/**
 * When each device was last closed — absent until its first close this session. Per device
 * (MICA-264): putting the phone down and raising the tablet is not the tablet having sat
 * closed for no time at all.
 */
const closedAt = new Map<DeviceId, number>();

/**
 * `Shell.svelte` calls this when `visible` goes false, and a device switch calls it for the
 * device it is leaving while a frame stays up — the browser's swap, which never closes.
 */
export const noteLockScreenClosed = (device: DeviceId = get(activeDevice)): void => {
  closedAt.set(device, Date.now());
};

/**
 * `Shell.svelte` calls this when `visible` goes true — synchronous, so the lock screen (or
 * its absence) is the very first thing painted rather than a flash of the home screen
 * followed by the lock snapping in a frame later.
 *
 * No passcode set means nothing to check the entry against, so there is nothing to lock —
 * the row in Settings is what invites a player to set one, not this function guessing at a
 * default.
 *
 * Per device since MICA-264. A device whose chrome has no lock screen never locks. A
 * passcode answer that is not this device's — a switch has asked and not yet heard back —
 * locks: showing the lock screen for the moment it takes to learn there is no passcode is
 * the honest mistake, and showing the home screen of a device that has one is not. The
 * switch (`state/deviceIdentity.ts`) evaluates again once the answer lands.
 */
export const evaluateLockOnOpen = (): void => {
  const device = get(activeDevice);
  lockedForUnknown = false;
  if (!DEVICES[device].chrome.lockScreen) {
    isLocked.set(false);
    return;
  }
  if (get(passcodeAnswerFor) !== device) {
    isLocked.set(true);
    lockedForUnknown = true;
    // Ask again — or join the ask already out. The subscription below lifts this lock if
    // the answer is "no passcode"; without the ask, a failed one was final for the session.
    void ensurePasscodeAnswer();
    return;
  }
  if (!get(hasPasscode)) {
    isLocked.set(false);
    return;
  }

  const policy = policyUnconfirmed ? 'onClose' : get(autoLockPolicy);
  if (policy === 'never') {
    isLocked.set(false);
    return;
  }
  if (policy === 'onClose') {
    isLocked.set(true);
    return;
  }

  // 'onTimeout': lock only if enough time has actually passed since this device was put
  // down. `closedAt` has no entry on the device's very first open of a session, which
  // reads as "just started" rather than "just closed" — locking on that would ask for a
  // passcode on page load, before the player ever closed anything.
  const last = closedAt.get(device);
  isLocked.set(last !== undefined && Date.now() - last >= AUTO_LOCK_TIMEOUT_MS);
};

/** A correct passcode, or the emergency-call bypass, both go through here. */
export const unlock = (): void => {
  lockedForUnknown = false;
  isLocked.set(false);
};

/**
 * Whether the lock on screen is there only because the passcode answer was unknown when the
 * frame came up — not because a passcode and the auto-lock policy put it there.
 */
let lockedForUnknown = false;

/**
 * Let an unknown-answer lock go once the answer turns out to be "no passcode" (MICA-385).
 *
 * The answer now starts unknown, and stays so after a failed ask, so a frame raised before it
 * lands is locked — the browser's first open can follow `Shell.svelte`'s mount-time ask
 * within a tick, and in game a phone opened before the character loaded waits for the ask a
 * character load makes. With no passcode there was never anything to check, so the lock
 * lifts the moment that is known, whoever asked.
 *
 * Only ever towards unlocked, and only for "no passcode": an answer that a passcode exists
 * keeps the lock as it is, and whoever asked re-evaluates with the policy in hand — a device
 * switch or a character load (`state/deviceIdentity.ts`) waits for the settings hydrate too,
 * since the policy is a setting and the one on hand may be the previous identity's.
 */
passcodeAnswerFor.subscribe((answerFor) => {
  if (!lockedForUnknown || !get(isLocked)) return;
  const device = get(activeDevice);
  if (answerFor !== device || get(openDevice) !== device || get(hasPasscode)) return;
  unlock();
});
