import './inProcess/facets/lockScreen';
import { guarded } from './guard';

/**
 * The lock screen's settings, read-only — whether a passcode is set, and the auto-lock
 * policy (MICA-60). Changing either is `useLockScreenWrite`.
 */
export function useLockScreen() {
  return guarded('useLockScreen').facets.lockScreen();
}
