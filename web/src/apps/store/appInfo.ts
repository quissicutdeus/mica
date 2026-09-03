// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  appStorageBytes,
  useAppRegistry,
  fetchCatalog,
  tileFromColorClasses,
  type AppManifest,
  type AppPermission,
  type CatalogEntry,
  type Translate
} from '@gos/sdk';

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
 * fictions stood in for are tracked in the gOS Jira project (`MICA`), which
 * cannot pretend to be installable.
 *
 * A function, not a constant, and it has to be. The registry globs every manifest eagerly,
 * each manifest imports `@gos/sdk`, and the SDK barrel reaches back into the registry —
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
    console.warn(`gOS Store: failed to fetch remote catalog from '${catalogUrl}':`, err);
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
 * collision: those four are the only add-ons gOS ships, so they are the obvious ids for
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
      `gOS Store: the catalog offers '${app.id}', which this build also ships. ` +
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
 * in-repo app authored by anyone but 'gOS' or 'Community' was core to the registry
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

/**
 * The glyph beside each permission. The **label** is not here any more (MICA-217): it lives
 * in the Store's catalog under `store.permission.<name>`, in every locale the Store ships,
 * and is read through `$t` at render time like every other string the Store shows. A label
 * table in a `.ts` file was the one place a player's language could not reach — the scanner
 * in `lib/hardcodedStrings.test.ts` reads `.svelte` files, so forty English strings sat
 * here unseen while every `.svelte` around them was extracted. That test now reads the
 * `.ts` files under `apps/` too, so the table cannot come back.
 *
 * The icon stays, because an emoji is not prose and a catalog of them per locale would be
 * thirty-eight copies of the same characters.
 */
const ICONS: Record<AppPermission, string> = {
  account: '\u{1F4B3}',
  admin: '\u{1F6E1}\u{FE0F}',
  bank: '\u{1F4B8}',
  call: '\u{1F4DE}',
  camera: '\u{1F4F7}',
  contacts: '\u{1F4C7}',
  highscores: '\u{1F3C6}',
  location: '\u{1F4CD}',
  mail: '\u{2709}\u{FE0F}',
  marketplace: '\u{1F6D2}',
  media: '\u{1F5BC}\u{FE0F}',
  messages: '\u{1F4AC}',
  notifications: '\u{1F514}',
  reports: '\u{1F6A9}',
  social: '\u{1F465}',
  storage: '\u{1F4BE}',
  'app-events': '\u{1F4E1}',
  'app-registry': '\u{1F4E6}',
  'app-registry-write': '\u{1F4E6}',
  clock: '\u{1F552}',
  'clock-write': '\u{1F552}',
  devtools: '\u{1F6E0}\u{FE0F}',
  display: '\u{1F4F1}',
  'display-write': '\u{1F4F1}',
  keybinds: '\u{2328}\u{FE0F}',
  'keybinds-write': '\u{2328}\u{FE0F}',
  'lock-screen': '\u{1F512}',
  'lock-screen-write': '\u{1F512}',
  music: '\u{1F3B5}',
  navigation: '\u{21AA}\u{FE0F}',
  'notification-settings': '\u{1F515}',
  'notification-settings-write': '\u{1F515}',
  'system-hardware': '\u{1F50B}',
  'system-hardware-write': '\u{1F50B}',
  theme: '\u{1F3A8}',
  'theme-write': '\u{1F3A8}',
  wallpaper: '\u{1F5BC}\u{FE0F}',
  'wallpaper-write': '\u{1F5BC}\u{FE0F}'
};

/**
 * A permission as a player should read it, in the phone's language.
 *
 * `translate` is the caller's `$t`, passed in rather than read here through `get(t)`, so a
 * rendered label re-derives when the locale changes — a module-scope read would be right
 * once and stale after Settings > Language. A name the catalog does not know (an add-on
 * declaring a permission this build has no word for) falls through to the raw name and a
 * gear, the same as before; the test proves nothing in the vocabulary does.
 */
export function formatPermission(
  perm: AppPermission,
  translate: Translate
): { label: string; icon: string } {
  const key = `store.permission.${perm}`;
  const label = translate(key);
  return { label: label === key ? perm : label, icon: ICONS[perm] ?? '\u{2699}\u{FE0F}' };
}

/**
 * What an update would add to what the player has actually granted (MICA-196, -201).
 *
 * It compared against the *installed manifest*, on the reasoning that `installVerified`
 * builds that manifest from the catalog entry and `AppDetails` lists it beside the Install
 * button, so the manifest was the record of what was agreed to. MICA-201 replaced that
 * record with one the shell owns: the manifest is what the bundle asks for, the grant is
 * what the player answered, and only the second is a thing the Store could not have
 * written on the player's behalf. Comparing against the manifest also meant the prompt
 * could be skipped by whatever wrote the manifest, which is the same hole seen from the
 * Store's end.
 *
 * Here rather than inside `index.svelte` so it can be tested as what it is: a set
 * difference that decides whether a player is asked. Returned in the entry's own order, so
 * the dialog reads the way the catalog wrote it.
 */
export function addedPermissions(
  granted: readonly AppPermission[] | undefined,
  entry: Pick<CatalogEntry, 'permissions'>
): AppPermission[] {
  const held = new Set(granted ?? []);
  return (entry.permissions ?? []).filter((perm) => !held.has(perm));
}
