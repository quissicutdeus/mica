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
  /**
   * Tailwind background class for the launcher icon — `bg-indigo-600`.
   *
   * A **class**, not a color value. `AppIcon` interpolates this straight into a `class`
   * attribute, so a hex string becomes a class name matching no rule and the icon renders
   * with no background at all. The docstring here used to offer "or hex string", which is
   * why that is worth stating outright.
   */
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
/** What `pnpm new:app` enforces for a scaffolded app; a hand-written manifest bypassed it. */
const ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export function defineApp(manifest: AppManifest): AppManifest {
  if (!manifest.id || typeof manifest.id !== 'string') {
    throw new Error("gPhone App Manifest error: 'id' is required and must be a string.");
  }
  if (!manifest.name || typeof manifest.name !== 'string') {
    throw new Error("gPhone App Manifest error: 'name' is required and must be a string.");
  }

  /**
   * Lowercased, because `navigation.ts` lowercases on the way in and the registry keys on
   * whatever this returns. When those disagreed, an app with a capital in its id got a
   * launcher icon whose tap resolved to `undefined` — and `Shell.svelte` renders nothing
   * for that. No icon, no error, no crash.
   *
   * Normalised rather than merely reported: `id` is also the storage namespace and an
   * event segment, and one canonical spelling is the only way those stay in step.
   */
  const id = manifest.id.toLowerCase();

  if (import.meta.env.DEV) {
    if (id !== manifest.id) {
      console.warn(
        `gPhone App Manifest: id '${manifest.id}' is not lowercase and has been read as ` +
          `'${id}'. It is a directory name, a storage namespace and an event segment — ` +
          `spell it lower_snake_case in the manifest.`
      );
    } else if (!ID_PATTERN.test(id)) {
      console.warn(
        `gPhone App Manifest: id '${id}' is not lower_snake_case. ` +
          `'pnpm new:app' enforces ${ID_PATTERN}; a hand-written manifest does not.`
      );
    }

    if (typeof manifest.color === 'string' && manifest.color.trim().startsWith('#')) {
      console.warn(
        `gPhone App Manifest: color '${manifest.color}' on '${id}' is a hex value, and ` +
          `AppIcon interpolates it into a class attribute — the icon will have no ` +
          `background. Use a Tailwind class such as 'bg-indigo-600'.`
      );
    }
  }

  const isSystem = manifest.isSystem ?? (!manifest.isRemote && manifest.author !== 'Community');
  const author = manifest.author || (isSystem ? 'gPhone' : 'Community');

  return {
    version: MICA_VERSION,
    permissions: [],
    defaultProps: {},
    isSystem,
    author,
    ...manifest,
    // After the spread: the normalised id has to win over the one that was passed in.
    id
  };
}
