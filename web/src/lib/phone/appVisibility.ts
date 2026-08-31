import type { AppCapability, AppManifest } from '../../../../sdk/manifest';

/**
 * Whether an app should appear on this phone at all — the rule, with no stores behind it.
 *
 * There were four copies of the `requiresAdmin` half — `Launcher`, `AppDrawer`,
 * `FolderPopup` and `searchResults` each spelled `!manifest.requiresAdmin || $isAdmin` out
 * for themselves — and a fifth surface, `Dock`, that had never had one, so an app hidden
 * everywhere else still drew its icon there and still opened from it. That is the shape of
 * bug a second axis makes permanent: adding `requires` to four filters and missing the
 * fifth ships a gate that silently stops applying on the surface nobody looked at.
 *
 * **Both axes are visibility, not authorization.** `requiresAdmin` and `requires` say as
 * much about themselves in `sdk/manifest.ts`, and neither is a boundary: the server
 * re-checks every privileged action (AGENTS.md §2.9) and refuses what it would have
 * refused anyway. Nothing here is load-bearing against a modified client.
 *
 * Split from `shell/state/appVisibility.ts`, which holds the same rule as a store, for one
 * concrete reason: `shell/state/searchResults.ts` is a pure module with a node-environment
 * suite behind it, and `services/admin.ts` reads `window` at module scope to decide its own
 * starting value. Importing the store form from there took `searchResults.test.ts` down on
 * `window is not defined` before a single assertion ran. The rule has no need of a browser;
 * only the two answers it consumes do.
 */
export type CapabilitySet = Readonly<Partial<Record<AppCapability, boolean>>>;

export interface VisibilityFacts {
  isAdmin: boolean;
  capabilities: CapabilitySet;
}

/** Whether `requires` is satisfied by a given answer. Absent and `false` are the same no. */
export const capabilitiesSatisfy = (
  set: CapabilitySet,
  requires: readonly AppCapability[] | undefined
): boolean => (requires ?? []).every((name) => set[name] === true);

/**
 * A missing manifest is not visible.
 *
 * An id on the home grid, in a folder, or in a dock slot can outlive the app it names — an
 * add-on uninstalled, or a build that no longer ships it — and every caller resolves an id
 * before asking, so answering here saves each of them a separate null check that would
 * otherwise be four more places to forget one.
 */
export const manifestVisible = (
  manifest: AppManifest | null | undefined,
  facts: VisibilityFacts
): boolean => {
  if (!manifest) return false;
  if (manifest.requiresAdmin && !facts.isAdmin) return false;
  return capabilitiesSatisfy(facts.capabilities, manifest.requires);
};
