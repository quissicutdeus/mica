import { ALL_PERMISSIONS } from '../../manifest';
import { setSystemHost, systemHost } from '../current';
import { createInProcessHost } from './createInProcessHost';

/**
 * Install the system host: an in-process host that declares every permission there is,
 * used as `guarded()`'s last-resort fallback before boot has set up anything more
 * specific. Idempotent — calling it again once a system host is already set is a no-op,
 * so `guarded()` can call it lazily without racing whatever boot does.
 */
function installSystemHost(): void {
  try {
    systemHost();
    return; // already set
  } catch {
    // fall through and install
  }
  setSystemHost(createInProcessHost('system', ALL_PERMISSIONS));
}

export { installSystemHost };
