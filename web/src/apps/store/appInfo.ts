import {
  appStorageBytes,
  useAppRegistry,
  fetchCatalog,
  tileFromColorClasses,
  type AppManifest,
  type AppPermission,
  type CatalogEntry
} from '@gphone/sdk';

/**
 * What the Store knows about an app before anyone taps it.
 *
 * Pulled out of `index.svelte` because three screens needed the same answers and each
 * would otherwise have taken them as props from a parent that had no other reason to
 * know them.
 */

/**
 * Everything the Store offers, sorted by name.
 *
 * Entirely derived — there is no hand-written list here, and that is the point.
 *
 * Two rounds of the same lesson got us here. Notes was once a hand-written copy of its own
 * manifest, reachable only while somebody remembered to duplicate it, and the copy drifted
 * from the real one. Then four invented add-ons — Blabber, Crypto Tracker, Downtown Taxi,
 * Marketplace — sat here as manifests with no code behind them, so the Store's catalog was
 * mostly fiction and installing any of it got a screen apologising for itself. Both are gone.
 * An app appears in the Store by *existing* and shipping `core: false`; the ideas the
 * fictions stood in for are tracked in the gPhone Jira project (`MICA`), which
 * cannot pretend to be installable.
 *
 * A function, not a constant, and it has to be. The registry globs every manifest eagerly,
 * each manifest imports `@gphone/sdk`, and the SDK barrel reaches back into the registry —
 * so anything reading `bundledAddOns` at module scope reads it before that glob has
 * finished and gets `undefined`. Calling it at render time sidesteps the cycle entirely.
 */
export const catalogApps = (): AppManifest[] =>
  [...useAppRegistry().bundledAddOns].sort((a, b) => a.name.localeCompare(b.name));

/**
 * A remote catalog entry, shaped exactly like `CatalogList.svelte` already expects.
 *
 * No new list component: `CatalogList` only ever reads `id`/`name`/`version`/`description`/
 * `icon`/`color`, every one of which a `CatalogEntry` already carries. `isRemote`/`bundleUrl`
 * ride along so `handleInstall` in `index.svelte` can tell which install path to call.
 */
const toAppManifest = (entry: CatalogEntry): AppManifest => ({
  id: entry.id,
  name: entry.name,
  version: entry.version,
  description: entry.description,
  icon: entry.icon ?? null,
  color: entry.color,
  // `isCatalogEntry` has already refused any row whose `color` names no `bg-` class, so the
  // fallback is unreachable — it is there to keep the type honest rather than to invent a
  // colour, since a catalog entry is remote data and this file does not get to throw.
  tile: tileFromColorClasses(entry.color) ?? { bg: entry.color },
  core: false,
  isRemote: true,
  bundleUrl: entry.bundleUrl,
  permissions: entry.permissions,
  requiresNetwork: entry.requiresNetwork ?? false
});

/**
 * Every app a configured remote catalog offers, or an empty list with no catalog
 * configured — a server that hasn't set one up yet sees exactly what it saw before this
 * shipped.
 */
export async function remoteCatalogApps(catalogUrl: string | undefined): Promise<AppManifest[]> {
  if (!catalogUrl) return [];
  try {
    const entries = await fetchCatalog(catalogUrl);
    return entries.map(toAppManifest);
  } catch (err) {
    // The remote catalog is additive — the bundled add-ons above have nothing to do with
    // it. A down server, a bad host, or malformed JSON here must degrade to "no remote
    // apps this boot," not take the Store's own bundled list down with it.
    console.warn(`gPhone Store: failed to fetch remote catalog from '${catalogUrl}':`, err);
    return [];
  }
}

/**
 * Bundled add-ons, then whatever a configured remote catalog offers — **one row per id**.
 *
 * This concatenated the two lists, which is fine until an operator's catalog offers an id
 * this build also ships. `CatalogList` keys its `{#each}` on `id`, and Svelte 5 throws
 * `each_key_duplicate` on a repeated key — so the whole Store crashed to `AppCrashed` the
 * moment a catalog named `blabber`, `notes`, `hodlr` or `snek`. That is not an exotic
 * collision: those four are the only add-ons gPhone ships, so they are the obvious ids for
 * an operator republishing one with a change of their own, and it is the first thing anyone
 * following `docs/addon-catalog.md` would try. Nothing caught it, because nothing had ever
 * fetched a real catalog (MICA-126).
 *
 * **The catalog entry wins.** An operator publishing an id had to allowlist its host first
 * and then write the entry by hand, so it is the more deliberate of the two statements; it
 * carries a version and a pinned hash, so it can be updated later, where a bundled copy is
 * frozen into this build with nowhere newer to fetch from. Dropping it instead would mean
 * silently ignoring the one thing the operator actually configured, which is the failure
 * this whole ticket is about. It is logged rather than done quietly — a shadowed id is
 * worth knowing about even when it is what you meant.
 */
export async function mergedCatalogApps(catalogUrl: string | undefined): Promise<AppManifest[]> {
  const remote = await remoteCatalogApps(catalogUrl);
  const remoteIds = new Set(remote.map((app) => app.id));

  const bundled = catalogApps().filter((app) => {
    if (!remoteIds.has(app.id)) return true;
    console.warn(
      `gPhone Store: the catalog offers '${app.id}', which this build also ships. ` +
        `Listing the catalog's copy.`
    );
    return false;
  });

  return [...bundled, ...remote];
}

/**
 * There is no `isSystemApp()` here any more, and its absence is the point.
 *
 * It re-derived "does this ship with the phone" from `isRemote` and `author`, which is the
 * same question `defineApp` was answering separately — and the two answers differed. An
 * in-repo app authored by anyone but 'gPhone' or 'Community' was core to the registry
 * (so `unregisterApp` threw) and an add-on to this file, so the Store rendered an Uninstall
 * button that could only fail. Read `app.core`: one answer, decided once, by the manifest.
 */

/**
 * What the app has actually stored.
 *
 * This used to be `(id.length + name.length + permissions.length) * 85`, invented to fill the
 * row. It was also quietly coupled to the manifest: declaring one more permission made the
 * app look bigger. Storage is namespaced per app, so the true figure was always available.
 */
export function getAppStorageSize(app: AppManifest): string {
  if (app.core) return 'System Protected';

  const bytes = appStorageBytes(app.id);
  if (bytes === 0) return 'No data stored';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const LABELS: Record<AppPermission, { label: string; icon: string }> = {
  account: { label: 'Phone Number & Bank Balance', icon: '\u{1F4B3}' },
  admin: { label: 'Moderation Tools', icon: '\u{1F6E1}\u{FE0F}' },
  bank: { label: 'Send Money', icon: '\u{1F4B8}' },
  call: { label: 'Phone Calls', icon: '\u{1F4DE}' },
  camera: { label: 'Camera Access', icon: '\u{1F4F7}' },
  contacts: { label: 'Contacts Access', icon: '\u{1F4C7}' },
  highscores: { label: 'Leaderboards', icon: '\u{1F3C6}' },
  location: { label: 'Location Services', icon: '\u{1F4CD}' },
  mail: { label: 'Mail', icon: '\u{2709}\u{FE0F}' },
  marketplace: { label: 'Marketplace Listings', icon: '\u{1F6D2}' },
  media: { label: 'Photos & Media', icon: '\u{1F5BC}\u{FE0F}' },
  messages: { label: 'Messages', icon: '\u{1F4AC}' },
  notifications: { label: 'Notifications', icon: '\u{1F514}' },
  reports: { label: 'Report Content', icon: '\u{1F6A9}' },
  social: { label: 'Social Profiles', icon: '\u{1F465}' },
  storage: { label: 'Local Storage', icon: '\u{1F4BE}' },
  'app-events': { label: 'Background Updates', icon: '\u{1F4E1}' },
  'app-registry': { label: 'Install & Remove Apps', icon: '\u{1F4E6}' },
  clock: { label: 'Clock Settings', icon: '\u{1F552}' },
  devtools: { label: 'Developer Tools', icon: '\u{1F6E0}\u{FE0F}' },
  display: { label: 'Display Settings', icon: '\u{1F4F1}' },
  keybinds: { label: 'Keyboard Shortcuts', icon: '\u{2328}\u{FE0F}' },
  music: { label: 'Play Music Out Loud', icon: '\u{1F3B5}' },
  navigation: { label: 'Open Other Apps', icon: '\u{21AA}\u{FE0F}' },
  'notification-settings': { label: 'Notification Settings', icon: '\u{1F515}' },
  'system-hardware': { label: 'Battery, Signal & Bluetooth', icon: '\u{1F50B}' },
  theme: { label: 'Theme', icon: '\u{1F3A8}' },
  wallpaper: { label: 'Wallpaper', icon: '\u{1F5BC}\u{FE0F}' }
};

/** A permission as a player should read it. */
export function formatPermission(perm: AppPermission): { label: string; icon: string } {
  return LABELS[perm] ?? { label: perm, icon: '\u{2699}\u{FE0F}' };
}
