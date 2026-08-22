import type { Component, Snippet } from 'svelte';
import type { Readable } from 'svelte/store';

/**
 * What an app may ask the shell for, one name per thing reached.
 *
 * Was eight names of which six were checked and two (`network`, `bluetooth`) checked by
 * nothing. Now one per host hook, so a manifest can be complete — which is what lets the
 * host refuse an undeclared call once add-ons leave the shell's context (MICA-16).
 * A handful of hooks are *implicit* and never declared: the ones every app is built out
 * of (`useAppLevels`, `useAppAction`, `useDeepLink`, `onAppForeground`/`useTimer`,
 * `useService` in its own namespace). Listing those on every manifest would tell a
 * player nothing. See `sdk/permissions.ts`.
 */
export const ALL_PERMISSIONS = [
  // Player data — a service behind each
  'account', // own phone number, bank balance, citizenid
  'admin', // moderation queue and admin actions
  'call',
  'camera',
  'contacts',
  'highscores',
  'location',
  'mail',
  'marketplace',
  'media',
  'messages',
  'notifications', // read the shade, or raise a toast
  'reports', // file a report
  'social', // @handles, follows, blocks, reactions
  'storage',
  // The phone itself
  'app-events',
  'app-registry',
  'clock',
  'devtools',
  'display',
  'keybinds',
  'navigation',
  'notification-settings',
  // No 'sound': `useSound` is implicit (`PERMISSION_OF.useSound === null`). Its facet is one
  // `play(effect)` over a fixed built-in set, used by kit widgets — `AppIcon`, `ToggleSwitch`,
  // `SegmentedControl` — that every app renders with, so a name to declare would be a name
  // nothing checks.
  'system-hardware', // battery, signal, bluetooth, volume
  'theme',
  'wallpaper'
] as const;

export type AppPermission = (typeof ALL_PERMISSIONS)[number];

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

/**
 * A manifest as an author writes it, before `defineApp` fills in the defaults.
 *
 * Separate from `AppManifest` for one reason: `name` is optional here and guaranteed on the
 * way out, so everything downstream can read `manifest.name` without a fallback.
 */
export type AppManifestInput = Omit<AppManifest, 'name'> & { name?: string };

/**
 * A default hotkey an app declares for itself.
 *
 * Deliberately no `scope` or `when` here — an app-declared bind is always phone-scope
 * and eligible only while that app is foreground. Both are derived by the runtime
 * aggregator in `shell/state/keybinds.ts` as `scope: 'phone'` and `when: 'app:${appId}'`,
 * which is what stops an app claiming an unscoped action or another app's context.
 */
export interface AppKeybindInput {
  /** Unique within this app's own list. Namespaced automatically to `${appId}:${id}`. */
  id: string;
  /** Shown in Settings > Shortcuts. */
  label: string;
  defaultKey: string;
}

export interface AppManifest {
  /**
   * Unique id — `contacts`, `crypto_tracker`. lower_snake_case.
   *
   * The stable one. It is a directory name, the `gphone:<id>:` storage namespace, the
   * `<app>` segment of every net event, a keybind claim and the `?app=` deep link. Renaming
   * it is a data migration, not a rename, which is exactly why it is not derived from
   * `name`: a display string should be free to change without orphaning stored data or
   * altering event names that server code handles.
   */
  id: string;
  /**
   * Display name on the home screen. Cosmetic — the launcher label, the Store listing and
   * the error-boundary message, nothing that is keyed on.
   *
   * Optional on input. `defineApp` title-cases the id when it is omitted, so `crypto_tracker`
   * becomes "Crypto Tracker" and all twelve apps in this repo needed only the id. Give it
   * explicitly when the display name is not simply the id — "GPS", "My Bank".
   */
  name: string;
  /**
   * Utility class for the launcher icon (from app-utilities.css) — `bg-indigo-600`.
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
  /**
   * Load this app's data while the phone opens, before the launcher draws.
   *
   * Declared by the app rather than listed by the shell. `bootstrap.ts` used to name each
   * store by hand, and nothing connected that list to the apps it was loading for — so an
   * app that shipped a `badgeStore` and was forgotten there showed a stale badge until
   * somebody opened it, which is precisely when a badge no longer matters.
   *
   * Only for what has to be right *before* first paint. Everything else belongs in
   * `onAppForeground`, which reloads per visit; this runs once per phone-open.
   */
  preload?: () => Promise<unknown> | void;
  /** Semantic version string (e.g. "1.0.0") */
  version?: string;
  /** App author or developer team */
  author?: string;
  /** Brief description of app functionality */
  description?: string;
  /**
   * What this app reaches for, as shown to a player in the Store.
   *
   * **A disclosure, not only a sandbox.** A `core: true` app runs in the shell's own JS
   * context, so nothing stops it importing a hook it did not declare; a `core: false`
   * add-on runs in a sandboxed iframe and has the shell re-check every call. Either way
   * §2.9 is the real boundary underneath: the server gates privileged actions and does not
   * take a NUI request as proof of intent.
   *
   * What is enforced is that the disclosure is **true**. `sdk/permissions.test.ts` reads
   * each app's SDK imports and fails the build if it reaches for contacts, photos, the
   * camera, notifications or local storage without saying so. Declaring more than the scan
   * finds is allowed — `network` and `location` have no hook to infer them from.
   */
  permissions?: AppPermission[];
  /**
   * Default hotkeys this app wants, shown grouped under it in Settings > Shortcuts.
   * Only apps for which this is set contribute app-scoped keybinds; most apps omit it.
   */
  keybinds?: AppKeybindInput[];
  /** Default props passed when launching app component */
  defaultProps?: Record<string, unknown>;
  /** Flag indicating whether app was dynamically loaded from a remote bundle */
  isRemote?: boolean;
  /** Remote bundle URL if dynamically loaded */
  bundleUrl?: string;
  /**
   * Does this app ship with the phone, and is it therefore not uninstallable?
   *
   * **Required, and deliberately not inferred.** It was once `isSystem`, defaulted from
   * `author` — a display string — so an app whose author was anything other than
   * `'Community'` silently became unremovable, and naming yourself `'gPhone'` was enough to
   * do it. Two things followed from deriving a protection boundary instead of stating it:
   * the derivation was circular (`isSystem` read `author`, then `author` read `isSystem`),
   * and a second, subtly different copy of it grew in the Store — so the registry and the
   * uninstall button could disagree about the same app, and the button threw.
   *
   * A remote app is never core. `defineApp` forces `false` when `isRemote` is set and
   * throws on an explicit `core: true` beside it: a downloaded bundle asking for protection
   * is broken or hostile. That closes a footgun rather than preventing an attack — an
   * add-on runs in the shell's own JS context regardless (§7).
   */
  core: boolean;
  /**
   * Hide the app entirely unless the player holds an admin ace.
   *
   * A visibility hint, not a permission. The server gates every privileged action it
   * exposes; this only stops the icon appearing for everyone else.
   */
  requiresAdmin?: boolean;
  /**
   * Does this app need the NUI bridge to work at all?
   *
   * Used to be inferred from `permissions.includes('network')` — but `network` disclosed
   * nothing (every app talks to its own service, so marking it on everyone would mean
   * marking it on no one) and conflated two different questions: what a player should be
   * told an app reaches for, and whether the phone should block the app while signal is
   * out. This is the second question, stated on its own rather than smuggled through the
   * permission list. `Shell.svelte`'s "Not Network" gate reads this, not `permissions`.
   */
  requiresNetwork?: boolean;
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
/** `crypto_tracker` -> `Crypto Tracker`. */
const titleCase = (id: string) =>
  id
    .split('_')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');

/** What `pnpm new:app` enforces for a scaffolded app; a hand-written manifest bypassed it. */
const ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export function defineApp(manifest: AppManifestInput): AppManifest {
  if (!manifest.id || typeof manifest.id !== 'string') {
    throw new Error("gPhone App Manifest error: 'id' is required and must be a string.");
  }
  if (manifest.name !== undefined && (typeof manifest.name !== 'string' || !manifest.name)) {
    throw new Error("gPhone App Manifest error: 'name' must be a non-empty string.");
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

  /**
   * `ext_` belongs to resources outside gPhone.
   *
   * An external script raises a notification under `ext_<resource>` so it gets its own
   * group in the shade rather than borrowing an app's. That only holds if no gPhone app
   * can ever take one of those ids — otherwise the day somebody ships an app called
   * `ext_tracker` it silently merges with a server owner's notifications, and neither
   * side can tell.
   *
   * A throw rather than a warning, because the collision is invisible once it exists and
   * the fix afterwards is a data migration (§11.1: the id is a key, not a label).
   */
  if (id.startsWith('ext_')) {
    throw new Error(
      `gPhone App Manifest error: id '${id}' uses the reserved 'ext_' prefix, which is ` +
        `for notifications raised by resources outside gPhone. Choose another id.`
    );
  }

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
          `background. Use a utility class such as 'bg-indigo-600'.`
      );
    }
  }

  const isRemote = manifest.isRemote === true;

  if (isRemote && manifest.core === true) {
    throw new Error(
      `gPhone App Manifest error: remote app '${id}' declares 'core: true'. A downloaded ` +
        `bundle must stay uninstallable.`
    );
  }

  /**
   * A remote app is never core, and does not have to say so — which is also what keeps a
   * bundle written before `core` existed loading at all.
   */
  const core = isRemote ? false : manifest.core;

  if (typeof core !== 'boolean') {
    throw new Error(
      `gPhone App Manifest error: '${id}' must declare 'core'. It decides whether the app ` +
        `can be uninstalled, and is deliberately not inferred — it used to be derived from ` +
        `'author', which made a display string load-bearing.`
    );
  }

  const author = manifest.author || 'gPhone';

  return {
    version: MICA_VERSION,
    permissions: [],
    defaultProps: {},
    ...manifest,
    // All after the spread, so they win over whatever was passed in: the normalized id over
    // the raw one, and the derived name over an explicit `name: undefined` — which spreads
    // as a present key and would otherwise clobber the default.
    //
    // `core` is here rather than above the spread for a sharper reason. It used to sit
    // before it, so a remote manifest declaring `isSystem: true` survived normalization
    // intact and `unregisterApp` then refused to remove it, forever. Normalising and *then*
    // spreading is what let the bundle win; spreading and then normalizing is what stops it.
    id,
    name: manifest.name ?? titleCase(id),
    core,
    author
  };
}
