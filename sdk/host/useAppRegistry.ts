import { guarded } from './guard';

/**
 * OS Service Hook for the app registry — read-only: the installed list, the bundled
 * add-ons the Store can offer, and the update queue. Installing, removing, or updating an
 * app is `useAppRegistryWrite` (MICA-127) — see its own doc for why every mutating
 * member throws inside a sandboxed add-on regardless of what its manifest declares.
 */
export function useAppRegistry() {
  return guarded('useAppRegistry').facets.appRegistry();
}
