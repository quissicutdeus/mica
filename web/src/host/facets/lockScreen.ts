import { readable } from 'svelte/store';
import { registerFacet } from '../../../../sdk/host/current';
import { autoLockPolicy, AUTO_LOCK_POLICY_CHOICES } from '../../shell/state/lockScreen';
import { hasPasscode } from '../../services/passcode';

/**
 * The lock screen's settings, read-only — whether a passcode is set, and the auto-lock
 * policy. Changing either is `useLockScreenWrite` (MICA-60), the same read/write split
 * `useClock`/`useClockWrite` already established.
 */
export function lockScreen() {
  return {
    /** Whether the player has a passcode set at all — Settings' own read, and `PhoneFrame`'s. */
    hasPasscode,
    autoLockPolicy,
    /** A `readable` wrapper, not the bare array — same transport reasoning `ringModeChoices`
     *  documents in `systemHardware.ts`: nothing needs this before hydration. */
    autoLockPolicyChoices: readable(AUTO_LOCK_POLICY_CHOICES)
  };
}

registerFacet('lockScreen', lockScreen);
