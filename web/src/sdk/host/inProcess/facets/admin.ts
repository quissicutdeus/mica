import { registerFacet } from '../../current';
import { isAdmin, refreshAdmin } from '../../../../services/admin';

/**
 * OS Service Hook for the player's admin status.
 *
 * Read-only as far as apps are concerned: this reflects what the server said, and
 * nothing an app does can change it. Gating a screen on it hides a button, never a
 * capability — the privileged action itself is checked again server-side.
 */
export function admin() {
  return { isAdmin, refreshAdmin };
}

registerFacet('admin', admin);
