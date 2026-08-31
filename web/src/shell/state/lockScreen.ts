import { writable, get } from 'svelte/store';
import { usePersisted } from '../../../../sdk/host/usePersisted';
import { hasPasscode } from '../../services/passcode';

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
    description: 'Ask for the passcode every time the phone is opened.'
  },
  {
    id: 'onTimeout',
    label: 'On Timeout',
    description: 'Only ask after the phone has been closed for a few minutes.'
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

/** Whether the lock screen is the thing `PhoneFrame.svelte` should paint right now. */
export const isLocked = writable(false);

/** When the phone was last closed — `null` until the first close this session. */
const closedAt = writable<number | null>(null);

/** `Shell.svelte` calls this when `visible` goes false. */
export const noteLockScreenClosed = (): void => {
  closedAt.set(Date.now());
};

/**
 * `Shell.svelte` calls this when `visible` goes true — synchronous, so the lock screen (or
 * its absence) is the very first thing painted rather than a flash of the home screen
 * followed by the lock snapping in a frame later.
 *
 * No passcode set means nothing to check the entry against, so there is nothing to lock —
 * the row in Settings is what invites a player to set one, not this function guessing at a
 * default.
 */
export const evaluateLockOnOpen = (): void => {
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

  // 'onTimeout': lock only if enough time has actually passed since the phone was put
  // down. `closedAt` is null on the very first open of a session, which reads as "just
  // started" rather than "just closed" — locking on that would ask for a passcode on
  // page load, before the player ever closed anything.
  const last = get(closedAt);
  isLocked.set(last !== null && Date.now() - last >= AUTO_LOCK_TIMEOUT_MS);
};

/** A correct passcode, or the emergency-call bypass, both go through here. */
export const unlock = (): void => isLocked.set(false);
