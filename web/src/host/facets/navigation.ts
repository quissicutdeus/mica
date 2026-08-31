import { registerFacet } from '../../sdk/host/current';
import { currentApp, openApp, goHome, closePhone } from '../../shell/state/navigation';

/**
 * OS Service Hook for phone navigation (opening apps, returning home, closing phone shell).
 *
 * `consumeDeepLink` used to live here, reachable only through an `isImplicitNavPlumbing`
 * exemption since `useDeepLink` is implicit and no real caller ever held `navigation`
 * permission for it. Moved to the dedicated `lifecycle` facet (MICA-27) — this facet's
 * members now all genuinely require the `navigation` permission, no exemption at all.
 */
export function navigation() {
  return {
    currentApp,
    openApp: (appName: string, props: Record<string, unknown> = {}) => openApp(appName, props),
    goHome: () => goHome(),
    closePhone: () => closePhone()
  };
}

registerFacet('navigation', navigation);
