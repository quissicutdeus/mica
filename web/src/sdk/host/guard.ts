import { getContext } from 'svelte';
import { PERMISSION_OF } from '../permissions';
import { HOST_CONTEXT_KEY, type Host } from './protocol';
import { hostFor, systemHost, markSystemHostWarned } from './current';
import { installSystemHost } from './inProcess/system';

/**
 * Every SDK host hook's entry point into the host protocol.
 *
 * Resolution order: the Svelte-context host set by `HostProvider` (an app rendered under
 * the shell) → the registered host for `appId` (a call from store/service scope where a
 * caller already knows which app it's acting for) → the system host (everything else —
 * including every hook today, since nothing is wired to `HostProvider` yet).
 *
 * `require()` on the resolved host is what turns a missing permission into a thrown
 * `AppPermissionError` rather than `capability.ts`'s dev-only warning.
 */
function guarded(hookName: keyof typeof PERMISSION_OF, appId?: string): Host {
  let host: Host | undefined;

  try {
    host = getContext<Host | undefined>(HOST_CONTEXT_KEY);
  } catch {
    host = undefined;
  }

  if (!host && appId) {
    host = hostFor(appId);
  }

  if (!host) {
    try {
      host = systemHost();
    } catch {
      installSystemHost();
      host = systemHost();
    }
    if (import.meta.env.DEV && markSystemHostWarned(hookName)) {
      console.warn(
        `[gPhone] '${hookName}' fell back to the system host — no app-scoped Host was found.`
      );
    }
  }

  host.require(PERMISSION_OF[hookName], hookName);
  return host;
}

export { guarded };
