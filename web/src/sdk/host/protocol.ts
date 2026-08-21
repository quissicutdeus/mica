import type { AppPermission } from '../manifest';
import type { Facets } from './inProcess/facets';

/** Svelte context key an app-scoped `Host` is set/read under. */
export const HOST_CONTEXT_KEY = 'gphone_host';

/**
 * Moved verbatim from the old sdk/capability.ts, deleted in MICA-16 step 3: the host protocol is where
 * this now gets thrown for real, rather than only constructed and never raised.
 */
export class AppPermissionError extends Error {
  constructor(
    public readonly appId: string,
    public readonly permission: AppPermission,
    public readonly hookName: string
  ) {
    super(
      `App '${appId}' denied access to '${hookName}': missing declared permission '${permission}'.`
    );
    this.name = 'AppPermissionError';
  }
}

/**
 * Facets a `Host` exposes beyond `require`/`appId`/`permissions` — the actual data/service
 * surface a hook reaches through the host rather than importing `shell/`/`client/` directly.
 */
export type HostFacets = Facets;

/**
 * What every SDK host hook goes through once rewired (MICA-16 step 3). One `Host` per
 * app: what it may ask for (`permissions`), what refuses an undeclared ask (`require`),
 * and what it can reach once allowed (`facets`).
 */
export interface Host {
  readonly appId: string;
  readonly permissions: readonly AppPermission[];
  /**
   * Throws `AppPermissionError` unless every permission in `needed` is declared.
   * `needed: null` is a no-op — the hook is one of the implicit ones every app is built
   * out of and is never declared (see `sdk/permissions.ts`).
   */
  require(needed: AppPermission | readonly AppPermission[] | null, hookName: string): void;
  readonly facets: HostFacets;
}
