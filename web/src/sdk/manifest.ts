import type { Snippet } from 'svelte';

export type AppPermission =
  'notifications' | 'contacts' | 'camera' | 'media' | 'storage' | 'location' | 'network';

export interface AppManifest {
  /** Unique ID for the application (e.g., "contacts", "crypto_tracker") */
  id: string;
  /** Human-readable display name on home screen */
  name: string;
  /** Tailwind background color class or hex string for launcher icon badge */
  color: string;
  /** Svelte component, snippet, icon component, or image URL representing the app icon */
  icon: Snippet | string | any;
  /** Optional reactive badge store for unread counts / notifications */
  badgeStore?: any;
  /** Semantic version string (e.g. "1.0.0") */
  version?: string;
  /** App author or developer team */
  author?: string;
  /** Brief description of app functionality */
  description?: string;
  /** Declared platform permissions required by app */
  permissions?: AppPermission[];
  /** Default props passed when launching app component */
  defaultProps?: Record<string, any>;
  /** Flag indicating whether app was dynamically loaded from a remote bundle */
  isRemote?: boolean;
  /** Remote bundle URL if dynamically loaded */
  bundleUrl?: string;
  /** Explicit flag indicating whether app is a protected system core app */
  isSystem?: boolean;
  /**
   * Hide the app entirely unless the player holds an admin ace.
   *
   * A visibility hint, not a permission. The server gates every privileged action it
   * exposes; this only stops the icon appearing for everyone else.
   */
  requiresAdmin?: boolean;
  /** ISO date string when app was installed */
  installedAt?: string;
  /** ISO date string when app was last updated */
  updatedAt?: string;
}

import { MICA_VERSION } from './version';

/**
 * Helper function to define and validate a gPhone application manifest.
 * Ensures required fields exist and applies sensible defaults for third-party apps.
 */
export function defineApp(manifest: AppManifest): AppManifest {
  if (!manifest.id || typeof manifest.id !== 'string') {
    throw new Error("gPhone App Manifest error: 'id' is required and must be a string.");
  }
  if (!manifest.name || typeof manifest.name !== 'string') {
    throw new Error("gPhone App Manifest error: 'name' is required and must be a string.");
  }

  const isSystem = manifest.isSystem ?? (!manifest.isRemote && manifest.author !== 'Community');
  const author = manifest.author || (isSystem ? 'gPhone' : 'Community');

  return {
    version: MICA_VERSION,
    permissions: [],
    defaultProps: {},
    isSystem,
    author,
    ...manifest
  };
}
