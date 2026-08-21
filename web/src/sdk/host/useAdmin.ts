import { isAdmin, refreshAdmin } from '../../services/admin';
import { assertCapability } from '../capability';

/**
 * OS Service Hook for the player's admin status.
 *
 * Read-only as far as apps are concerned: this reflects what the server said, and
 * nothing an app does can change it. Gating a screen on it hides a button, never a
 * capability — the privileged action itself is checked again server-side.
 */
export function useAdmin() {
  assertCapability('admin', 'useAdmin');
  return { isAdmin, refreshAdmin };
}
