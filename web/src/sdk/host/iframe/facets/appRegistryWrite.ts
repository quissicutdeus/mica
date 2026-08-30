import { registerFacet } from '../../current';
import { type AsTwin } from './_shared';

type Twin = AsTwin<
  ReturnType<typeof import('../../inProcess/facets/appRegistryWrite').appRegistryWrite>
>;

const refused = () => {
  throw new Error('[gPhone] only a core app may install or remove apps');
};

/**
 * OS Service Hook for installing, removing or updating an app, seen from inside a
 * sandboxed add-on. Every member throws locally rather than round-tripping a call — an
 * add-on never installs or removes apps, regardless of whether its manifest declares
 * `app-registry-write`. The shell refuses it too: `IframeHostServer`'s `MEMBER_ALLOWLIST`
 * lists no member for this facet at all, so a raw `postMessage` that skips this twin gets
 * a "core only" error rather than an install. This is the polite half of that pair — a
 * synchronous throw at the call site instead of a rejected promise — not the enforcing half.
 */
export function appRegistryWrite(): Twin {
  return {
    refreshUpdates: refused,
    updateApp: refused,
    installFromCatalog: refused,
    registerApp: refused,
    registerAddOn: refused,
    unregisterApp: refused
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('appRegistryWrite', appRegistryWrite);
