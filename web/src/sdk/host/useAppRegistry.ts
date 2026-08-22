import './inProcess/facets/appRegistry';
import { guarded } from './guard';

/**
 * OS Service Hook for dynamic app registry & remote app installation.
 *
 * `registerApp(manifest, component)` is the in-process path — core apps, and (dev-only)
 * runtime fixtures. `registerAddOn(manifest, source?)` is everything else: an add-on's
 * bundle is source text, run in a sandboxed iframe, never a component the shell executes
 * itself (MICA-16 step 4). A caller inside a sandboxed add-on gets a twin where every
 * mutating member — including `registerAddOn` — throws: only a core app installs or
 * removes apps.
 */
export function useAppRegistry() {
  return guarded('useAppRegistry').facets.appRegistry();
}
