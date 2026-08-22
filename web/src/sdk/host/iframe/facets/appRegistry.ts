import { registerFacet } from '../../current';
import { fn, store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/appRegistry').appRegistry>;

const refused = () => {
  throw new Error('[gPhone] only a core app may install or remove apps');
};

/**
 * OS Service Hook for the app registry, seen from inside a sandboxed add-on.
 *
 * An add-on never installs or removes apps — that stays a core-app-only operation, so
 * every mutating member here throws locally rather than round-tripping a call. The shell
 * refuses them too: `IframeHostServer`'s `MEMBER_ALLOWLIST` lets only `registryStore` and
 * `getFirstBootTime` through for this facet, so a raw `postMessage` that skips this twin
 * gets a "core only" error rather than an install. This is the polite half of that pair —
 * a synchronous throw at the call site instead of a rejected promise — not the enforcing
 * half.
 */
export function appRegistry(): Twin {
  return {
    registryStore: store('appRegistry', [], 'registryStore', []),
    /** Add-ons don't list add-ons. */
    bundledAddOns: [],
    getFirstBootTime: fn('appRegistry', [], 'getFirstBootTime'),
    installFromCatalog: refused,
    registerApp: refused,
    registerAddOn: refused,
    unregisterApp: refused
  } as unknown as Twin;
}

registerFacet('appRegistry', appRegistry);
