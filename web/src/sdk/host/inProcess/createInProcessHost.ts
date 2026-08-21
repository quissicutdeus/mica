import type { AppPermission } from '../../manifest';
import { AppPermissionError, type Host } from '../protocol';
import { facets } from '../current';

/**
 * Build the `Host` an in-process app (every app in this repo today; a Store add-on later)
 * gets. `require` is where a manifest's declared `permissions` become an actual refusal
 * instead of `capability.ts`'s dev-only warning.
 *
 * `facets` is the shared registry from `current.ts` — a `Proxy` that resolves each facet
 * lazily from whichever hook files have been imported so far, not a per-host object this
 * file builds. This file therefore imports only `../../manifest`, `../protocol` and
 * `../current` — no facet module, and nothing that reaches `shell/`, `services/` or `nui/`.
 */
export function createInProcessHost(appId: string, permissions: readonly AppPermission[]): Host {
  function require(
    needed: AppPermission | readonly AppPermission[] | null,
    hookName: string
  ): void {
    if (needed === null) return;
    const list: readonly AppPermission[] = Array.isArray(needed) ? needed : [needed];
    const missing = list.find((p) => !permissions.includes(p));
    if (missing !== undefined) {
      throw new AppPermissionError(appId, missing, hookName);
    }
  }

  return {
    appId,
    permissions,
    require,
    facets
  };
}
