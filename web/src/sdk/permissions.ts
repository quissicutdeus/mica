import type { AppPermission } from './manifest';

/**
 * Every host hook, and the permission that discloses it. `null` is implicit: the hook is
 * one every app is built out of and is never declared.
 *
 * This is the one table. `permissions.test.ts` proves it against the actual source, not
 * against filenames — a row is checked by locating the `export function`/`export const`
 * of that exact name under `sdk/host` (several rows, like `appStorageBytes` and
 * `clearAppStorage`, share a file with `useStorage` and are not named after it):
 *
 * - every host hook has a row (file → table)
 * - every non-kit row names a symbol that actually exists under `sdk/host` (table → file,
 *   catches a stale or renamed entry)
 * - every row's located export calls `guarded()` with that row's exact name, as its own
 *   statement — not a call belonging to some other export in the same file — including
 *   the implicit (`null`) rows, which still resolve through `guarded()` even though they
 *   carry no permission to check
 * - every app's manifest declares what its `@gphone/sdk` imports need
 *
 * The two kit-component rows (`PhotoPickerModal`, `ReportDialog`) are exempt from the
 * assert check: they live under `sdk/ui`, not `sdk/host`, and disclose through the host
 * hook they call internally rather than asserting themselves. A kit-component row may list
 * more than one permission — a component can call several host hooks at init, not just
 * one — where every other row names exactly one, because a host hook asserts exactly one
 * capability.
 *
 * The host protocol (MICA-16, step 3) reads this same table in `guard.ts` to refuse a
 * call outright rather than merely warn about it. `guarded()` attributes a call in this
 * order: the Svelte-context host (an app rendered under `HostProvider`) → the registered
 * host for an explicit app id (store/service scope) → the `system` host, which grants
 * every permission and only exists in-process — it is not a stand-in for a real app's
 * host now that a `core: false` add-on runs in its own sandboxed iframe, out of the
 * shell's JS context.
 *
 * Since Step 4, `PERMISSION_OF` also backs `HOOK_OF_FACET`, which the shell consults to
 * re-check every add-on's `postMessage` call before answering it. The frame runs its own
 * `guarded()` check first, but that check is inside the sandbox and is a courtesy to the
 * add-on author, not the boundary — the shell-side re-check is what actually refuses.
 */
export const PERMISSION_OF: Record<string, AppPermission | readonly AppPermission[] | null> = {
  // implicit — what an app is made of
  useAppLevels: null,
  useAppAction: null,
  useDeepLink: null,
  useTimer: null,
  onAppForeground: null,
  onAppUnmount: null,
  useService: null,
  // MICA-27: no public hook of its own — the wall-crossing plumbing `onAppForeground`,
  // `useDeepLink`, the `onback` prop, and `useAppLevels`'s physical Back binding are built
  // out of. See `IframeHostServer.ts`'s `APP_SCOPED_FACETS` doc for why this replaced a
  // string allow-list (`isImplicitNavPlumbing`) instead of exempting specific members of
  // the general `navigation`/`keybinds` facets.
  lifecycle: null,
  // `sound.ts`'s own doc comment: this facet is playback of a fixed built-in effect set,
  // nothing else, "used by AppIcon, ToggleSwitch and SegmentedControl" — shared UI kit
  // widgets every app, core or not, is expected to render with. Gating it behind a
  // declared permission never bit a core app (it always holds every permission), but the
  // first real caller with a genuine restricted set — a sandboxed add-on — hit it on
  // literally any screen with a tab bar or a toggle, for a capability with no more
  // sensitivity than a UI sound effect.
  useSound: null,
  // data
  useAccount: 'account',
  useAdmin: 'admin',
  useReports: 'admin',
  useCall: 'call',
  useCamera: 'camera',
  useContacts: 'contacts',
  useHighscores: 'highscores',
  useLocation: 'location',
  useMail: 'mail',
  useMarketplace: 'marketplace',
  useMedia: 'media',
  useMessages: 'messages',
  useNotifications: 'notifications',
  usePhoneNotification: 'notifications',
  useReport: 'reports',
  useAccounts: 'social',
  useStorage: 'storage',
  usePersisted: 'storage',
  appStorageBytes: 'storage',
  clearAppStorage: 'storage',
  // shell
  useAppEvents: 'app-events',
  useAppRegistry: 'app-registry',
  useClock: 'clock',
  useDevTools: 'devtools',
  useDisplay: 'display',
  useKeybinds: 'keybinds',
  useNavigation: 'navigation',
  useNotificationSettings: 'notification-settings',
  useSystemHardware: 'system-hardware',
  useTheme: 'theme',
  useWallpaper: 'wallpaper',
  // kit components that call a host hook on the app's behalf
  PhotoPickerModal: 'media',
  ReportDialog: ['reports', 'notifications']
};

/**
 * Facet name → the hook that owns it. The iframe server (MICA-16 step 4) receives
 * *facet* names over the wire and has to re-check the permission on the shell side —
 * the frame's own `require` runs in untrusted code. `PERMISSION_OF` is keyed by hook, so
 * this is the join. `permissions.test.ts` proves it is total.
 */
export const HOOK_OF_FACET = {
  account: 'useAccount',
  accounts: 'useAccounts',
  admin: 'useAdmin',
  call: 'useCall',
  camera: 'useCamera',
  contacts: 'useContacts',
  highscores: 'useHighscores',
  location: 'useLocation',
  mail: 'useMail',
  marketplace: 'useMarketplace',
  media: 'useMedia',
  messages: 'useMessages',
  notifications: 'useNotifications',
  reports: 'useReports',
  report: 'useReport',
  appAction: 'useAppAction',
  appEvents: 'useAppEvents',
  appLevels: 'useAppLevels',
  appRegistry: 'useAppRegistry',
  clock: 'useClock',
  deepLink: 'useDeepLink',
  devTools: 'useDevTools',
  display: 'useDisplay',
  keybinds: 'useKeybinds',
  navigation: 'useNavigation',
  notificationSettings: 'useNotificationSettings',
  phoneNotification: 'usePhoneNotification',
  sound: 'useSound',
  systemHardware: 'useSystemHardware',
  theme: 'useTheme',
  wallpaper: 'useWallpaper',
  storage: 'useStorage',
  appStorageBytes: 'appStorageBytes',
  clearAppStorage: 'clearAppStorage',
  persisted: 'usePersisted',
  service: 'useService',
  timer: 'useTimer',
  onAppForeground: 'onAppForeground',
  onAppUnmount: 'onAppUnmount',
  lifecycle: 'lifecycle'
} as const satisfies Record<string, keyof typeof PERMISSION_OF>;

export function permissionOfFacet(facet: string) {
  const hook = (HOOK_OF_FACET as Record<string, keyof typeof PERMISSION_OF>)[facet];
  return hook ? { hook, needed: PERMISSION_OF[hook] } : undefined;
}

/**
 * Facets a raw `call`/`subscribe` must never name directly, regardless of what permission
 * they require (MICA-21/33). Each is a bare function, `void`, or a primitive — no
 * member object to gate through the normal `requireMember`/`decodeArgs` path, so naming
 * the facet directly reaches the factory itself with an attacker-controlled
 * `appId`/handler and no `pinAppId`/`decodeArgs` pass on it. `onAppForeground` (MICA-21)
 * was exactly this shape: constructing it immediately subscribes a handler onto a
 * long-lived store, so a broken handler throws every time that store next fires, for the
 * life of the page.
 *
 * Not every entry here is *implicit* — `clearAppStorage`/`appStorageBytes` require the
 * real `storage` permission, same as `useStorage` itself, but are exactly as
 * bare-function-shaped and unpinned as the three implicit ones once an app has that
 * permission at all. Danger here tracks shape, not whether a manifest has to declare
 * anything.
 *
 * `IframeHostServer.ts`'s `DENIED_FACETS` **is** this set — imported, not duplicated, so
 * the enforcement and this classification cannot drift apart the way `DENIED_FACETS` and
 * `IframeHostServer.test.ts`'s own hardcoded list used to (two copies, one test, MICA-33).
 */
export const DENIED_FACETS: ReadonlySet<string> = new Set([
  'onAppForeground',
  'onAppUnmount',
  'deepLink',
  'clearAppStorage',
  'appStorageBytes'
]);

/**
 * Implicit facets (`PERMISSION_OF[hook] === null`) confirmed to return a real object with
 * members — safely reachable the ordinary way, pinned via
 * `APP_SCOPED_FACETS`/`CONFIG_APP_ID_FACETS` if they take an app id, gated per-member by
 * `requireMember`/`decodeArgs` otherwise (MICA-33).
 *
 * Scoped to *implicit* facets specifically, unlike `DENIED_FACETS`: a facet requiring a
 * real declared permission is already protected by that requirement regardless of shape,
 * so it needs no entry here — only the facets with no permission at all need a positive
 * "confirmed safe" record for `permissions.test.ts` to check every one of them against.
 * Together with `DENIED_FACETS`, this is what makes the check structural: a new implicit
 * facet landing in neither set fails loudly, which is what stops a future
 * `onAppForeground`-shaped facet from being *silently* reachable — it can still be
 * classified wrongly, but that is a review problem, not a forgotten one.
 */
export const SAFE_IMPLICIT_FACETS: ReadonlySet<string> = new Set([
  'appLevels',
  'appAction',
  'timer',
  'service',
  'sound',
  'lifecycle'
]);
