import './inProcess/facets/appRegistryWrite';
import { guarded } from './guard';

/**
 * OS Service Hook for installing, removing, or updating an app (MICA-127).
 *
 * `registerApp(manifest, component)` is the in-process path — core apps, and (dev-only)
 * runtime fixtures. `registerAddOn(manifest, source?)` is everything else: an add-on's
 * bundle is source text, run in a sandboxed iframe, never a component the shell executes
 * itself (MICA-16 step 4). A caller inside a sandboxed add-on gets a twin where every
 * member — including `registerAddOn` — throws, and `IframeHostServer`'s `MEMBER_ALLOWLIST`
 * refuses a raw `postMessage` naming this facet's members too: only a core app installs or
 * removes apps, regardless of whether an add-on's manifest declares `app-registry-write`.
 */
export function useAppRegistryWrite() {
  return guarded('useAppRegistryWrite').facets.appRegistryWrite();
}
