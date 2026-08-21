import type { AppPermission } from '../../manifest';
import { AppPermissionError, type Host, type HostFacets } from '../protocol';

/**
 * Build the `Host` an in-process app (every app in this repo today; a Store add-on later)
 * gets. `require` is where a manifest's declared `permissions` become an actual refusal
 * instead of `capability.ts`'s dev-only warning.
 *
 * `facets` is `{}` cast — no hook is rewired to reach through it yet (Task 2 of MICA-16
 * step 3 builds the real facet object).
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
    facets: {} as HostFacets
  };
}
