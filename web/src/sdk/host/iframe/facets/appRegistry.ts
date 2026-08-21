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
 * every mutating member here throws rather than round-tripping a call the shell would
 * refuse anyway.
 */
export function appRegistry(): Twin {
  return {
    registryStore: store('appRegistry', [], 'registryStore', []),
    /** Add-ons don't list add-ons. */
    bundledAddOns: [],
    getFirstBootTime: fn('appRegistry', [], 'getFirstBootTime'),
    loadRemoteApp: refused,
    installFromCatalog: refused,
    registerApp: refused,
    unregisterApp: refused
  } as unknown as Twin;
}

registerFacet('appRegistry', appRegistry);
