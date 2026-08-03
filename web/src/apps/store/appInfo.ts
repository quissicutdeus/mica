import { appStorageBytes, useAppRegistry, type AppManifest, type AppPermission } from '@gphone/sdk';

/**
 * What the Store knows about an app before anyone taps it.
 *
 * Pulled out of `index.svelte` because three screens needed the same answers and each
 * would otherwise have taken them as props from a parent that had no other reason to
 * know them.
 */

/**
 * Add-ons that exist only as catalogue entries — there is no code for these in the tree.
 * A real in-repo add-on does not belong here; see `catalogApps` below.
 */
const DEMO_APPS: AppManifest[] = [
  {
    id: 'chirper_social',
    name: 'Chirper',
    color: 'bg-sky-500',
    icon: 'https://raw.githubusercontent.com/feathericons/feather/master/icons/twitter.svg',
    version: '2.0.1',
    author: 'Chirper Media Inc.',
    description: 'Social media networking app to post updates, photos, and follow friends.',
    permissions: ['notifications', 'media', 'network', 'storage'],
    isRemote: true
  },
  {
    id: 'crypto_tracker',
    name: 'Crypto Tracker',
    color: 'bg-amber-500',
    icon: 'https://raw.githubusercontent.com/feathericons/feather/master/icons/trending-up.svg',
    version: '1.2.0',
    author: 'Satoshi Labs',
    description: 'Real-time cryptocurrency prices, portfolio tracking, and market analytics.',
    permissions: ['network', 'storage'],
    isRemote: true
  },
  {
    id: 'taxi_share',
    name: 'Downtown Taxi',
    color: 'bg-yellow-500',
    icon: 'https://raw.githubusercontent.com/feathericons/feather/master/icons/navigation.svg',
    version: '1.0.4',
    author: 'Los Santos Transit',
    description: 'Order rides, track cab locations, and pay fares directly from your phone.',
    permissions: ['location', 'network', 'notifications'],
    isRemote: true
  },
  {
    id: 'marketplace_app',
    name: 'Marketplace',
    color: 'bg-emerald-600',
    icon: 'https://raw.githubusercontent.com/feathericons/feather/master/icons/shopping-bag.svg',
    version: '1.1.0',
    author: 'Community Trade',
    description: 'Peer-to-peer marketplace to buy, sell, and auction items.',
    permissions: ['contacts', 'notifications', 'storage', 'network'],
    isRemote: true
  }
];

/**
 * Everything the Store offers, sorted by name.
 *
 * A function, not a constant, and it has to be. The registry globs every manifest eagerly,
 * each manifest imports `@gphone/sdk`, and the SDK barrel reaches back into the registry —
 * so anything reading `bundledAddOns` at module scope reads it before that glob has
 * finished and gets `undefined`. Calling it at render time sidesteps the cycle entirely.
 *
 * The in-repo half is derived. Notes used to be listed above as a hand-written copy of its
 * own manifest — an app with `isSystem: false` is kept out of the launcher and was reachable
 * only if somebody remembered to duplicate it here, and the duplicate then drifted from the
 * real one. Now any app shipping `isSystem: false` shows up by existing.
 */
export const catalogApps = (): AppManifest[] =>
  [...DEMO_APPS, ...useAppRegistry().bundledAddOns].sort((a, b) => a.name.localeCompare(b.name));

/**
 * A system app ships with the phone and cannot be uninstalled.
 *
 * Inferred rather than declared: anything remote is an add-on, and anything without an
 * author, or authored by gPhone itself, came in the box.
 */
export function isSystemApp(app: AppManifest): boolean {
  if (app.isSystem === false) return false;
  return !app.isRemote && (app.author === 'gPhone' || !app.author);
}

/**
 * What the app has actually stored.
 *
 * This used to be `(id.length + name.length + permissions.length) * 85`, invented to fill the
 * row. It was also quietly coupled to the manifest: declaring one more permission made the
 * app look bigger. Storage is namespaced per app, so the true figure was always available.
 */
export function getAppStorageSize(app: AppManifest): string {
  if (isSystemApp(app)) return 'System Protected';

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
