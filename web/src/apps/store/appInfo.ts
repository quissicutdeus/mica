import type { AppManifest, AppPermission } from '@gphone/sdk';

/**
 * What the Store knows about an app before anyone taps it.
 *
 * Pulled out of `index.svelte` because three screens needed the same answers and each
 * would otherwise have taken them as props from a parent that had no other reason to
 * know them.
 */

/** The add-ons on offer, sorted alphabetically by name. */
export const CATALOG_APPS: AppManifest[] = [
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
  },
  {
    id: 'notes',
    name: 'Notes',
    color: 'bg-yellow-400',
    icon: 'https://raw.githubusercontent.com/feathericons/feather/master/icons/file-text.svg',
    version: '1.0.0',
    author: 'Community',
    description: 'Create and store personal notes',
    permissions: ['storage'],
    isSystem: false
  }
];

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

/** A plausible size, derived from the manifest. Nothing measures real storage. */
export function getAppStorageSize(app: AppManifest): string {
  if (isSystemApp(app)) return 'System Protected';
  const length = (app.id.length + app.name.length + (app.permissions?.length || 0)) * 85;
  return `${(length / 10).toFixed(0)} KB`;
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
