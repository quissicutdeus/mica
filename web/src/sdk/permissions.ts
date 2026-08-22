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
