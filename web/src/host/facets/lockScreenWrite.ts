import { registerFacet } from '../../sdk/host/current';
import { setAutoLockPolicy } from '../../shell/state/lockScreen';
import type { AutoLockPolicy } from '../../sdk/vocabulary/shell';
import { setPasscodeRemote, clearPasscodeRemote } from '../../services/passcode';

/**
 * Implementation of the `useLockScreenWrite` facet — see that hook's doc for the usage
 * contract. `setPasscode`/`clearPasscode` round-trip the server (MICA-60); the passcode
 * itself never lands in browser storage on the way there.
 */
export function lockScreenWrite() {
  return {
    setAutoLockPolicy: (policy: AutoLockPolicy): void => setAutoLockPolicy(policy),
    setPasscode: (digits: string): Promise<void> => setPasscodeRemote(digits),
    clearPasscode: (): Promise<void> => clearPasscodeRemote()
  };
}

registerFacet('lockScreenWrite', lockScreenWrite);
