import { appStorageBytes, useAppRegistry, type AppManifest, type AppPermission } from '@gphone/sdk';

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
 * Marketplace — sat here as manifests with no code behind them, so the Store's catalogue was
 * mostly fiction and installing any of it got a screen apologising for itself. Both are gone.
 * An app appears in the Store by *existing* and shipping `core: false`; the ideas the
 * fictions stood in for are recorded in `docs/roadmap.md`, which cannot pretend to be
 * installable.
 *
 * A function, not a constant, and it has to be. The registry globs every manifest eagerly,
 * each manifest imports `@gphone/sdk`, and the SDK barrel reaches back into the registry —
 * so anything reading `bundledAddOns` at module scope reads it before that glob has
 * finished and gets `undefined`. Calling it at render time sidesteps the cycle entirely.
 */
export const catalogApps = (): AppManifest[] =>
  [...useAppRegistry().bundledAddOns].sort((a, b) => a.name.localeCompare(b.name));

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

/** A permission as a player should read it. */
export function formatPermission(perm: AppPermission): { label: string; icon: string } {
  switch (perm) {
    case 'notifications':
      return { label: 'Notifications', icon: '\u{1F514}' };
    case 'contacts':
      return { label: 'Contacts Access', icon: '\u{1F4C7}' };
    case 'camera':
      return { label: 'Camera Access', icon: '\u{1F4F7}' };
    case 'media':
      return { label: 'Photos & Media', icon: '\u{1F5BC}\u{FE0F}' };
    case 'storage':
      return { label: 'Local Storage', icon: '\u{1F4BE}' };
    case 'location':
      return { label: 'Location Services', icon: '\u{1F4CD}' };
    case 'network':
      return { label: 'Network Access', icon: '\u{1F310}' };
    default:
      return { label: perm, icon: '\u{2699}\u{FE0F}' };
  }
}
