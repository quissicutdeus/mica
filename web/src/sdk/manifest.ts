import type { Component, Snippet } from 'svelte';
import type { Readable } from 'svelte/store';

export type AppPermission =
  'notifications' | 'contacts' | 'camera' | 'media' | 'storage' | 'location' | 'network';

/**
 * What the shell hands an app component.
 *
 * There was no such type, and `Shell.svelte` rendered every app as `any` — so nothing was
 * checked across the one boundary every app crosses. It showed: five apps declared a bare
 * `$props()`, and of the seven that typed `onback`, Camera made it required and the rest
 * optional. Nothing could tell you which was right.
 *
 * It is **required**. The shell passes `onback={goHome}` unconditionally on every render,
 * so an app receiving nothing is not a state that exists, and declaring it optional forced
 * `onback?.()` at every call site to guard against a case the shell cannot produce.
 *
 * Deep-link props are the app's own, and it should say so by extending this:
 *
 * ```ts
 * let { onback, mailId } = $props<AppProps & { mailId?: number }>();
 * ```
 *
 * Keep those optional. A deep link is one way in among several, and the same component
 * still has to render when opened from the launcher with nothing.
 */
export interface AppProps {
  /** Leave the app. The shell's own back action — it goes home rather than up a level. */
  onback: () => void;
}

/**
 * Any app component the registry can mount.
 *
 * Extra props are fine as long as they are optional: an app declaring
 * `AppProps & { mailId?: number }` is still something the shell can render with `onback`
 * alone, which is exactly the guarantee that makes a deep link optional rather than a
 * second entry point.
 */
export type AppComponent = Component<AppProps>;

export interface AppManifest {
  /** Unique ID for the application (e.g., "contacts", "crypto_tracker") */
  id: string;
  /** Human-readable display name on home screen */
  name: string;
  /** Tailwind background color class or hex string for launcher icon badge */
  color: string;
  /** A Svelte component, a snippet, or an image URL. Null renders no glyph, which
   *  is what a remote app that shipped without one gets. */
  icon: Component<any> | Snippet | string | null;
  /** Reactive unread count for the launcher badge — `unreadMailCount` and friends. */
  badgeStore?: Readable<number>;
  /** Semantic version string (e.g. "1.0.0") */
  version?: string;
  /** App author or developer team */
  author?: string;
  /** Brief description of app functionality */
  description?: string;
  /** Declared platform permissions required by app */
  permissions?: AppPermission[];
  /** Default props passed when launching app component */
  defaultProps?: Record<string, unknown>;
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
