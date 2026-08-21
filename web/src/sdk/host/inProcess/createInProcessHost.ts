import { ALL_PERMISSIONS, type AppManifest, type AppPermission } from '../../manifest';
import { AppPermissionError, type Host } from '../protocol';
import { facets, hostFor, registerHost } from '../current';

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

/**
 * The `Host` `Shell.svelte` hands a running app instance: the registered host for
 * `appId` if one already exists, otherwise a freshly created and registered one built
 * from `manifest`'s declared permissions (`ALL_PERMISSIONS` for a `core` app).
 *
 * Re-registration on reinstall: a remote app can be uninstalled and reinstalled with a
 * *different* manifest — a new bundle version that declares more, fewer, or different
 * permissions (or flips `core`). If the already-registered host's permission list (or
 * core-ness) no longer matches what this manifest declares, this creates a fresh host
 * and re-registers it under the same `appId`, replacing the stale one rather than
 * silently keeping the old grant/refusal set alive across a reinstall.
 */
export function hostForApp(appId: string, manifest: AppManifest | undefined): Host {
  const existing = hostFor(appId);
  const wanted = manifest?.core ? ALL_PERMISSIONS : (manifest?.permissions ?? []);

  if (
    existing &&
    existing.permissions.length === wanted.length &&
    wanted.every((p) => existing.permissions.includes(p))
  ) {
    return existing;
  }

  const host = createInProcessHost(appId, wanted);
  registerHost(host);
  return host;
}
