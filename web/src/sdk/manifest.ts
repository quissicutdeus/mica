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
  // Separate from `account` on purpose: reading a balance and moving money are not the
  // same ask, and `account` is common enough (any app showing a balance) that bundling a
  // spend capability into it would grant it far wider than anyone declaring it intended.
  'bank', // send money to another player
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
  // MICA-127: `app-registry` only ever reads the installed list, the bundled add-ons the
  // Store can offer, and the update queue. Installing, removing or updating an app is a
  // separate ask, and (unlike the other splits below) already unreachable for a sandboxed
  // add-on regardless of permission — see `IframeHostServer`'s `MEMBER_ALLOWLIST`. Splitting
  // it anyway is a disclosure fix for a `core: true` app, which is never sandboxed.
  'app-registry-write',
  'clock',
  // MICA-127: `clock` only ever reads the time and the 12/24-hour preference. Changing
  // the preference is a phone-wide setting, not something every app that shows a clock
  // should be able to flip — split the way `bank` split off `account`.
  'clock-write',
  'devtools',
  'display',
  // MICA-127: `display` only ever reads how big the phone is drawn. Resizing the
  // window, rebuilding the home grid, or overriding motion for every app is Settings'
  // business, not any app that merely wants to know the current size.
  'display-write',
  'keybinds',
  // MICA-127: `keybinds` only ever lets an app claim an action for itself and read the
  // current bindings. Rebinding a key — or wiping every override — is a global write with
  // no member allowlist behind it today, unlike the read half.
  'keybinds-write',
  'lock-screen',
  // MICA-60: `lock-screen` only ever reads whether a passcode is set and the auto-lock
  // policy. Setting or clearing the passcode, and changing the policy, is `lock-screen-write`
  // — same split as every other MICA-127 pair above.
  'lock-screen-write',
  // Load a track and start or stop it. Separate from `system-hardware`, which owns the
  // phone's *UI sound* volume: an app that shows a battery level has no business also
  // being able to start playing something out loud.
  'music',
  'navigation',
  'notification-settings',
  // MICA-127: `notification-settings` only ever reads whether the player has muted an
  // app. Muting a rival, unmuting itself, or flipping Do Not Disturb is a separate ask,
  // and — like `app-registry-write` — already unreachable for a sandboxed add-on
  // regardless of permission (MICA-63's `MEMBER_ALLOWLIST` row). Splitting it anyway is
  // a disclosure fix for a `core: true` app.
  'notification-settings-write',
  // No 'sound': `useSound` is implicit (`PERMISSION_OF.useSound === null`). Its facet is one
  // `play(effect)` over a fixed built-in set, used by kit widgets — `AppIcon`, `ToggleSwitch`,
  // `SegmentedControl` — that every app renders with, so a name to declare would be a name
  // nothing checks.
  'system-hardware', // battery, signal, bluetooth, volume
  // MICA-127: `system-hardware` only ever reads the battery, signal, bluetooth state and
  // volume levels. Changing any of it — including Developer Tools' fake battery level — is
  // a separate ask.
  'system-hardware-write',
  'theme',
  // MICA-127: `theme` only ever reads the active seed and scheme. Changing the whole
  // phone's colour for every app is a much bigger ask than rendering in whatever is
  // already active.
  'theme-write',
  'wallpaper',
  // MICA-127: same split as `theme` — reading the current background and replacing it
  // for the whole phone are not the same ask.
  'wallpaper-write'
] as const;

export type AppPermission = (typeof ALL_PERMISSIONS)[number];

/**
 * What the *server* has to be able to do for an app to work at all, one name per thing
 * the phone cannot supply on its own.
 *
 * gPhone can run standalone, with no framework resource behind it — and a deployment with
 * no framework has no money. `Bank` and `Hodlr` are the two apps that move it, and a phone
 * that shows a Bank which always errors is worse than one that does not show it at all.
 *
 * A string vocabulary rather than a `requiresMoney?: boolean`, decided once and on
 * purpose. `AppManifest` is a published contract that every add-on anyone has shipped is
 * compiled against (§2.7), so adding a field to it is a one-time cost and adding a second
 * boolean later is a permanent one. `'inventory'` and whatever follows join this list
 * without touching the shape of the manifest again.
 *
 * Distinct from `AppPermission`, which is a *disclosure* about what an app reaches for and
 * is shown to a player in the Store. The two answers are independent: an app can honestly
 * declare the `bank` permission on a server that has no money at all.
 */
export const ALL_CAPABILITIES = [
  // Balances, transfers, prices — anything that moves currency. Comes from the framework
  // bridge, so it is simply absent in standalone mode.
  'money'
] as const;

/**
 * One capability an app may declare it cannot work without. See `AppManifest.requires`.
 */
export type AppCapability = (typeof ALL_CAPABILITIES)[number];

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
export type AppManifestInput = Omit<AppManifest, 'name' | 'tile' | 'color'> & {
  name?: string;
  tile?: AppTile;
  /** @deprecated Author `tile` instead. Accepted so an add-on bundle predating it still loads. */
  color?: string;
};

/**
 * A launcher tile, as two named roles rather than one string with two jobs in it.
 *
 * Both are utility classes from `app-utilities.css`, not colour values — `AppIcon`
 * interpolates them into a `class` attribute, so a hex string is a class name matching no
 * rule and the tile renders with no background at all. That used to be a DEV-only
 * `console.warn`, which is the weakest gate in the repo; `defineApp` throws on it now.
 */
export interface AppTile {
  /** What the tile is painted — `bg-indigo-600`. */
  bg: string;
  /**
   * What the glyph inherits — `text-gray-900`.
   *
   * Omit on a dark tile, where `--color-on-surface` from `Launcher` is already right. State
   * it on a light one: Notes on `bg-yellow-400` inherited a near-white glyph at 1.19:1, and
   * nothing in a single string could say whether that was a decision or an omission.
   */
  fg?: string;
}

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
   * The launcher tile: what it is painted, and what the glyph on it inherits.
   *
   * The authored field (MICA-91). It replaces a free-form `color` string that held both
   * roles at once, positionally and unchecked — which is what let a tile and its glyph
   * disagree, and what MICA-88 had to go and reconcile by hand across sixteen apps.
   */
  tile: AppTile;
  /**
   * `tile` flattened to the class string every consumer interpolates. **Derived — do not
   * author it.**
   *
   * Still here because ten-odd call sites read it (`AppIcon`, `Launcher`, `Dock`,
   * `AppDrawer`, `FolderPopup`, `DragGhost`, `ToastHost`, the Store and Settings listings)
   * and because an add-on bundle published before `tile` existed still sets it. `defineApp`
   * derives whichever of the two was not given, so both are always present and always
   * agree; writing both is refused rather than merged.
   */
  color: string;
  /** A Svelte component, a snippet, or an image URL. Null renders no glyph, which
   *  is what a remote app that shipped without one gets. */
  // A manifest icon can be any component with any props shape; `unknown` would reject every real component here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
   * Server capabilities this app cannot function without. Absent means it needs none.
   *
   * **A visibility contract, not a security boundary** — the same caveat `requiresAdmin`
   * carries, and worth restating rather than inferring. All this does is keep the icon
   * away from a phone where the app could not work; the server still refuses every action
   * it would have refused anyway (§2.9), and an app hidden here is not a disabled server
   * endpoint. A modified client can still emit whatever it likes.
   *
   * Not `permissions`, which is a disclosure of what the app reaches for, shown to a
   * player before they install it — that is a statement about the app, this is a statement
   * about what the deployment can do. Not `requiresNetwork` either: that blocks the app at
   * runtime, behind a "Not Network" screen, because cell signal comes back. A capability
   * the server does not have is not a transient condition, so the honest outcome is
   * absence rather than an app that is present and always errors.
   *
   * Absent is the only thing a bundle published before this field existed can say, and it
   * means exactly the right thing: this app needs nothing of the server beyond what every
   * app needs. `defineApp` supplies no default, so nothing already installed changes
   * behaviour and no consumer has to distinguish `undefined` from `[]`.
   */
  requires?: AppCapability[];
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
  /**
   * MICA-24: the exact origins a `core: false` add-on's sandboxed frame may `fetch()`.
   *
   * The frame has no Content-Security-Policy otherwise, so an add-on's own JS — not just
   * the code an author wrote, but anything a supply-chain compromise slipped into its
   * bundle — could silently call out to any host on the internet. `srcdoc.ts` turns this
   * list into the frame's `connect-src`; an empty or absent list means `connect-src
   * 'none'`, blocking outbound `fetch()` entirely.
   *
   * Declaring this without also declaring `requiresNetwork: true` is refused by
   * `defineApp` — asking for real network egress while saying the app does not need
   * network at all is a contradiction, not an oversight to let through quietly. The
   * reverse is fine and common: an app can need `requiresNetwork` (in-game cell signal,
   * for its ordinary server-proxied calls) without ever calling `fetch()` itself, and
   * should simply leave this empty rather than declare a host it does not use.
   *
   * Full origins only (`https://api.example.com`, no path) — `defineApp` rejects
   * anything else, since a bare hostname or a wildcard is not a valid CSP source and
   * `srcdoc.ts` does no correction of its own.
   */
  networkHosts?: readonly string[];
  /** ISO date string when app was installed */
  installedAt?: string;
  /** ISO date string when app was last updated */
  updatedAt?: string;
}

import { MICA_VERSION } from './version';
// Not `export * from './permissions'` anywhere in `index.ts`/`addon.ts` — deliberately.
// `validateManifestPermissions` is an internal check `defineApp` runs on every manifest,
// not a capability an app author calls, and this module's every export is swept into
// `@gphone/sdk`'s public surface by `index.ts`'s `export * from './manifest'`. Adding it
// here would make it public forever (MICA-16's "adding an export is a one-way door");
// living in `permissions.ts` instead — already outside both barrels — keeps it callable
// and independently testable without widening what an add-on can reach.
import { validateManifestPermissions } from './permissions';

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

/** One utility class, no whitespace — `bg-indigo-600`, `text-gray-900`. */
const oneClass = (prefix: string) => new RegExp(`^${prefix}-[A-Za-z0-9/[\\]._-]+$`);
const BG_CLASS = oneClass('bg');
const FG_CLASS = oneClass('text');

/**
 * A legacy `color` string split back into the two roles it was always carrying, or `null`
 * if it names no background at all.
 *
 * Exported because the Store's remote catalog is a wire format that still speaks `color`
 * (`shell/state/catalog.ts`) and has to turn one into a tile without importing `defineApp`,
 * which throws — a malformed row there is dropped and logged, not fatal.
 */
/** A tile as the one class string every consumer interpolates. */
const flattenTile = (tile: AppTile) => (tile.fg ? `${tile.bg} ${tile.fg}` : tile.bg);

export function tileFromColorClasses(color: string): AppTile | null {
  const tokens = color.trim().split(/\s+/);
  const bg = tokens.find((t) => BG_CLASS.test(t));
  if (!bg) return null;
  const fg = tokens.find((t) => FG_CLASS.test(t));
  return fg === undefined ? { bg } : { bg, fg };
}

/**
 * The tile, from whichever of the two fields the author used, validated either way.
 *
 * `tile` is the field to write. `color` is accepted because an add-on bundle published
 * before `tile` existed still sets it, and refusing those would break every installed
 * copy — so it is split back into its two roles here rather than carried around as a
 * string nobody can check. Both together is refused: that is the one input where they can
 * disagree, and picking a winner silently is how the original problem started.
 */
function resolveTile(id: string, input: { tile?: AppTile; color?: string }): AppTile {
  const { tile, color } = input;

  /**
   * Both fields, disagreeing. Refused rather than resolved: picking a winner silently is
   * how a tile and its glyph came apart in the first place.
   *
   * Agreeing is fine and routine — `defineApp` is not run once. `shell/state/registry.ts`
   * re-runs it over every already-defined manifest to stamp `installedAt`, so a manifest
   * arrives here carrying the `color` a previous pass derived. A rule that refused both
   * outright would fail every app in the repo at boot.
   */
  if (tile && color !== undefined && color !== flattenTile(tile)) {
    throw new Error(
      `gPhone App Manifest error: '${id}' declares both 'tile' and 'color', and they ` +
        `disagree ('${flattenTile(tile)}' vs '${color}'). They are the same thing — ` +
        `'color' is the legacy spelling, derived from 'tile'. Keep 'tile'.`
    );
  }

  if (tile) {
    if (!BG_CLASS.test(tile.bg)) {
      throw new Error(
        `gPhone App Manifest error: '${id}' has tile.bg '${tile.bg}', which is not a single ` +
          `'bg-' utility class from app-utilities.css. A hex value or a colour name is ` +
          `interpolated into a 'class' attribute and matches no rule, so the tile renders ` +
          `with no background at all.`
      );
    }
    if (tile.fg !== undefined && !FG_CLASS.test(tile.fg)) {
      throw new Error(
        `gPhone App Manifest error: '${id}' has tile.fg '${tile.fg}', which is not a single ` +
          `'text-' utility class. Omit it entirely for a dark tile, where the glyph inherits ` +
          `'--color-on-surface' and is already legible.`
      );
    }
    return tile.fg === undefined ? { bg: tile.bg } : { bg: tile.bg, fg: tile.fg };
  }

  if (typeof color !== 'string' || !color.trim()) {
    throw new Error(
      `gPhone App Manifest error: '${id}' must declare 'tile'. It is what the launcher ` +
        `paints the icon with, and there is no sensible default — an app with no tile is ` +
        `an invisible one.`
    );
  }

  const split = tileFromColorClasses(color);
  if (!split) {
    throw new Error(
      `gPhone App Manifest error: '${id}' has color '${color}', which names no 'bg-' ` +
        `utility class. It is interpolated into a 'class' attribute, so a hex value or a ` +
        `bare colour name renders no background at all. Prefer 'tile: { bg, fg }'.`
    );
  }
  return split;
}

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

  /**
   * MICA-24. Only the "declared hosts with no network need" direction is refused —
   * see `networkHosts`'s own doc for why the reverse (network but no hosts) is fine.
   */
  const networkHosts = manifest.networkHosts ?? [];
  if (networkHosts.length > 0 && manifest.requiresNetwork !== true) {
    throw new Error(
      `gPhone App Manifest error: '${id}' declares 'networkHosts' without 'requiresNetwork: ` +
        `true'. A CSP allowlist for network the app claims not to need is a contradiction.`
    );
  }
  const ORIGIN_PATTERN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i;
  for (const host of networkHosts) {
    if (!ORIGIN_PATTERN.test(host)) {
      throw new Error(
        `gPhone App Manifest error: '${id}' declares 'networkHosts' entry '${host}', which ` +
          `is not a bare https origin (scheme, host, optional port — no path). CSP's ` +
          `connect-src takes an origin, and 'srcdoc.ts' does not correct malformed entries.`
      );
    }
  }

  /**
   * A typo here fails loudly, for the same reason a malformed `tile` does: an unknown
   * capability can never be satisfied by any server, so the app would simply never appear
   * anywhere, with nothing said and nothing to notice it. `defineApp` is the only place
   * that can tell the author, and it runs at definition time.
   */
  const requires = manifest.requires;
  if (requires !== undefined) {
    if (!Array.isArray(requires)) {
      throw new Error(
        `gPhone App Manifest error: '${id}' has a 'requires' that is not an array. It lists ` +
          `the server capabilities the app cannot work without — requires: ['money'].`
      );
    }
    for (const capability of requires) {
      if (!(ALL_CAPABILITIES as readonly string[]).includes(capability)) {
        throw new Error(
          `gPhone App Manifest error: '${id}' declares an unknown capability ` +
            `'${String(capability)}' in 'requires'. Known capabilities: ` +
            `${ALL_CAPABILITIES.join(', ')}. An unknown one is never satisfied, so the app ` +
            `would be hidden on every server rather than on the ones that lack it.`
        );
      }
    }
  }

  const author = manifest.author || 'gPhone';

  /**
   * Both spellings, always in step. `color` is the flattened form every consumer already
   * interpolates; deriving it here is what makes `tile` a pure authoring change rather
   * than a rewrite of ten call sites and every published add-on.
   */
  const tile = resolveTile(id, manifest);
  const color = flattenTile(tile);

  validateManifestPermissions(id, manifest.permissions ?? [], ALL_PERMISSIONS);

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
    author,
    tile,
    color
  };
}
