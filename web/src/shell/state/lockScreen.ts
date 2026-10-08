// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable, get } from 'svelte/store';
import { usePersisted } from '../../../../sdk/host/usePersisted';
import { DEVICES, type DeviceId } from '@mica/shared/devices';
import { hasPasscode, passcodeAnswerFor } from '../../services/passcode';
import { activeDevice } from './device';

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

export const setAutoLockPolicy = (policy: AutoLockPolicy): void =>
  autoLockPolicy.set(sanitizePolicy(policy));

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
  if (!DEVICES[device].chrome.lockScreen) {
    isLocked.set(false);
    return;
  }
  if (get(passcodeAnswerFor) !== device) {
    isLocked.set(true);
    return;
  }
  if (!get(hasPasscode)) {
    isLocked.set(false);
    return;
  }

  const policy = get(autoLockPolicy);
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
export const unlock = (): void => isLocked.set(false);
