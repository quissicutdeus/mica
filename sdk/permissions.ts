// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

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
 * - every app's manifest declares what its `@mica/sdk` imports need
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
  // MICA-192: the AGPL §13 source address, which is one public string identical for every
  // caller — the same address printed in the README and on the release page. Gating a
  // licence notice behind a declared permission would mean an add-on could be refused the
  // ability to tell somebody what licence it is under, which is the opposite of the point.
  useSourceUrl: null,
  // MICA-61: which language the phone is in. Public for the same reason the source
  // address is — every app needs it to render at all, it carries no player data, and the
  // only member an add-on could steer is withheld by `MEMBER_ALLOWLIST`.
  useLocale: null,
  // MICA-249: whether the player asked for every picture to be blurred until tapped. One
  // boolean, no player data, and the one primitive that draws pictures (`MediaThumb`)
  // reads it for every app — so gating it would mean a kit component every app renders
  // needs a permission no app has a reason to declare. The setter is core only.
  useStreamerMode: null,
  // MICA-286: an app listing its own rows in the phone's search. Implicit for the same
  // reason `useAppLevels` and `useDeepLink` are — it is a way *into* this app and nothing
  // else. The shell pushes it one string, the player's own query, which the player is
  // typing at a sheet the app cannot see; the app answers with rows it already holds. A
  // permission here would gate an app's ability to be found, which is the one thing every
  // app on the home screen already is.
  useSearchProvider: null,
  // data
  useAccount: 'account',
  useAdmin: 'admin',
  useBank: 'bank',
  useReports: 'admin',
  useCall: 'call',
  useCamera: 'camera',
  useContacts: 'contacts',
  useHighscores: 'highscores',
  useJobs: 'jobs',
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
  useAppRegistryWrite: 'app-registry-write',
  useClock: 'clock',
  useClockWrite: 'clock-write',
  useDevTools: 'devtools',
  useDisplay: 'display',
  useDisplayWrite: 'display-write',
  useKeybinds: 'keybinds',
  useKeybindsWrite: 'keybinds-write',
  useLockScreen: 'lock-screen',
  useLockScreenWrite: 'lock-screen-write',
  useMusic: 'music',
  useNavigation: 'navigation',
  useNotificationSettings: 'notification-settings',
  useNotificationSettingsWrite: 'notification-settings-write',
  useSystemHardware: 'system-hardware',
  useSystemHardwareWrite: 'system-hardware-write',
  useTheme: 'theme',
  useThemeWrite: 'theme-write',
  useWallpaper: 'wallpaper',
  useWallpaperWrite: 'wallpaper-write',
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
  sourceUrl: 'useSourceUrl',
  locale: 'useLocale',
  streamerMode: 'useStreamerMode',
  bank: 'useBank',
  call: 'useCall',
  camera: 'useCamera',
  contacts: 'useContacts',
  highscores: 'useHighscores',
  jobs: 'useJobs',
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
  appRegistryWrite: 'useAppRegistryWrite',
  clock: 'useClock',
  clockWrite: 'useClockWrite',
  deepLink: 'useDeepLink',
  devTools: 'useDevTools',
  display: 'useDisplay',
  displayWrite: 'useDisplayWrite',
  keybinds: 'useKeybinds',
  keybindsWrite: 'useKeybindsWrite',
  lockScreen: 'useLockScreen',
  lockScreenWrite: 'useLockScreenWrite',
  music: 'useMusic',
  navigation: 'useNavigation',
  notificationSettings: 'useNotificationSettings',
  notificationSettingsWrite: 'useNotificationSettingsWrite',
  phoneNotification: 'usePhoneNotification',
  sound: 'useSound',
  systemHardware: 'useSystemHardware',
  systemHardwareWrite: 'useSystemHardwareWrite',
  theme: 'useTheme',
  themeWrite: 'useThemeWrite',
  wallpaper: 'useWallpaper',
  wallpaperWrite: 'useWallpaperWrite',
  searchProvider: 'useSearchProvider',
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
  'lifecycle',
  // MICA-192. One public string, identical for every caller, that the README and every
  // release page already publish. It carries no player data, takes no app id and has no
  // member an add-on could steer — reachable implicitly is the correct answer, not an
  // oversight, and refusing it would mean an add-on cannot state the licence it is under.
  'sourceUrl',
  // MICA-61. The locale is one string every app needs to render; `setLocale` is not on
  // the allowlist, so a frame can read the language and cannot change the player's.
  'locale',
  // MICA-249. One boolean every picture-drawing surface reads; `setStreamerMode` is not
  // on the allowlist, so a frame can honour the flag and cannot flip the player's.
  'streamerMode',
  // MICA-286. Returns a real object with two named members, so it is nothing like the
  // bare-function shape `DENIED_FACETS` exists for. What it takes is an app id, and an app
  // id is a claim: it decides which heading a frame's hits appear under, so it is pinned
  // in `IframeHostServer.ts`'s `APP_SCOPED_FACETS` alongside `storage`/`notifications`
  // rather than trusted. Safe *because* of that pin, not independently of it.
  'searchProvider'
]);

/**
 * What a sandboxed add-on may name on each facet, one row per reachable facet.
 *
 * ## Why this is a positive list and not an exception list
 *
 * It replaces `IframeHostServer`'s `MEMBER_ALLOWLIST`, which said the opposite thing: a
 * facet **absent** from that table was unrestricted, and a facet present in it exposed only
 * what it named. That is default-allow, and it failed in the way default-allow always
 * fails — quietly, one facet at a time, whenever somebody added a member and did not think
 * about the sandbox. Its own comments are the record of that. MICA-63 had to go and add
 * `notificationSettings` after an add-on could mute a rival app. MICA-127 split
 * `appRegistryWrite`/`notificationSettingsWrite` out and then had to name them here with
 * **empty** lists, because deleting their write members from the old rows would have
 * reopened every one of them on the new facet name. MICA-162 found `keybinds-write` —
 * `setBinding` takes any `actionId`, `resetBindings` wipes every override on the phone —
 * and needed a fourth empty row for the same reason. Four tickets, each closing one
 * instance of one gap, with nothing between them but somebody noticing.
 *
 * `PERMISSION_OF` and `HOOK_OF_FACET` above are proved total by `permissions.test.ts`; this
 * table was the one in the group that nothing checked. It is checked now, and it is
 * default-deny: a facet with no row is unreachable, and a member not named is unreachable,
 * so a new host member is refused until somebody writes it down.
 *
 * ## Where the rows come from
 *
 * Each row is what the facet's **iframe twin** actually sends over the wire —
 * `sdk/host/iframe/facets/<facet>.ts`, the code an add-on's own `@mica/sdk` resolves to —
 * minus the members deliberately blocked below. That bound is the point: the twin is the
 * SDK, so a member it never names is one no honest add-on can be calling, and a raw
 * `postMessage` naming it is by definition reaching past the SDK. `permissions.test.ts`
 * checks both halves — every non-denied facet has a row, and every member in a row is a
 * name its twin file actually mentions, so a rename cannot leave a dead entry behind.
 *
 * A facet whose twin runs entirely inside the frame gets an **empty** row rather than no
 * row: `appLevels` (built on `lifecycle.onBack`, which is pinned), `timer` (all local),
 * `persisted` (built on the `storage` facet). Empty and absent mean the same thing to
 * `requireMember`, and saying it out loud is what distinguishes "nothing crosses the wire
 * here" from "nobody has looked at this yet".
 *
 * ## The rows that are narrower than the wire
 *
 * Five facets deliberately allow less than their twin offers. The twin's own local throws
 * (`appRegistryWrite`'s `refused()`, and its siblings') are the polite half of this pair,
 * not the enforcing half — they are code inside the sandbox, and a raw `postMessage` skips
 * them entirely, which is exactly the boundary this table is.
 *
 * - `appRegistry` reads the installed list and the first-boot time. `installFromCatalog`,
 *   `registerAddOn` and `unregisterApp` live on `appRegistryWrite` and no add-on installs
 *   or removes an app, whatever its manifest declares.
 * - `notificationSettings` reads, never writes (MICA-63). Deciding what interrupts the
 *   player is the player's, through Settings.
 * - `keybindsWrite` is empty (MICA-162): both members are unscoped global writes with no
 *   legitimate add-on use. An app that wants a shortcut declares it in its manifest.
 * - `systemHardwareWrite` keeps the three reversible "how does this session sound" controls
 *   — `setVolume`, `setRingMode`, `previewRingtone` — and drops the seven device-wide ones.
 *   `setCharge`/`setSignal` falsify a hardware readout; `toggleBluetooth`/`toggleCellService`
 *   cut connectivity for every other app; `setRingtone`/`setVolumeStep` change a persisted
 *   device preference, unlike `previewRingtone`, which auditions and persists nothing; and
 *   `toggleMute` silences the whole device.
 * - `storage` has no `getItem`: the twin answers reads from the hydrate snapshot and only
 *   writes cross the wire.
 */
export const FACET_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  // Player data.
  account: [
    'myPhoneNumber',
    'bankBalance',
    'transactions',
    'transactionsLoaded',
    'historySource',
    'citizenid',
    'fetchPhoneNumber',
    'fetchBalance',
    'fetchTransactions',
    'fetchCitizenId'
  ],
  accounts: [
    'getMyAccounts',
    'getAccounts',
    'createAccount',
    'updateAccount',
    'getFollowStats',
    'getFollowers',
    'getFollowing',
    'searchAccounts',
    'followAccount',
    'unfollowAccount',
    'blockAccount',
    'unblockAccount',
    'getReactionsFor',
    'reactToTarget',
    'unreactToTarget'
  ],
  admin: ['isAdmin', 'refreshAdmin'],
  bank: [
    'sendMoney',
    'invoices',
    'invoicesLoaded',
    'fetchInvoices',
    'payInvoice',
    'declineInvoice'
  ],
  call: [
    'callStore',
    'startCall',
    'endCall',
    'answerCall',
    'toggleSpeaker',
    'callLog',
    'loadCallLog'
  ],
  camera: ['isTakingPhoto', 'isPreviewingPhoto'],
  contacts: [
    'contactsStore',
    'favoriteContacts',
    'addContact',
    'shareContact',
    'getDeletedContacts',
    'restoreContact'
  ],
  highscores: ['submitScore', 'getLeaderboard'],
  jobs: ['jobs', 'jobsLoaded', 'fetchJobs', 'setActiveJob', 'setDuty'],
  location: ['shareLocation', 'setWaypoint'],
  mail: [
    'mailStore',
    'unreadMailCount',
    'deleteMail',
    'markAsRead',
    'archiveMail',
    'addReceivedMail'
  ],
  marketplace: [
    'feedStore',
    'mineStore',
    'loadFeed',
    'searchListings',
    'loadMine',
    'viewListing',
    'postListing',
    'markSold',
    'removeListing'
  ],
  media: [
    'media',
    'capturePhoto',
    'deletePhoto',
    'dropNearby',
    'fullMedia',
    'getDeletedMedia',
    'restoreMedia'
  ],
  messages: [
    'conversationsStore',
    'unreadMessagesCount',
    'sendMessage',
    'addReceivedMessage',
    'startText',
    'messageReactions',
    'loadMessageReactions',
    'toggleMessageReaction'
  ],
  notifications: [
    'notificationsStore',
    'unreadCount',
    'totalUnread',
    'loaded',
    'load',
    'markRead',
    'clear',
    'clearAll'
  ],
  report: ['submit'],
  reports: [
    'pendingReports',
    'resolvedReports',
    'pendingReportCount',
    'loadPendingReports',
    'loadReportHistory',
    'resolveReport',
    'reopenReport'
  ],
  storage: ['setItem', 'removeItem', 'markUnsynced', 'clear'],

  // The phone itself.
  appAction: ['notify'],
  appEvents: ['on', 'onAny', 'clear'],
  appLevels: [],
  appRegistry: ['registryStore', 'getFirstBootTime'],
  appRegistryWrite: [],
  clock: ['time', 'is24Hour', 'formattedTime'],
  clockWrite: ['setIs24Hour'],
  devTools: ['devToolsUnlocked', 'unlock', 'lock'],
  display: [
    'device',
    'frame',
    'displaySize',
    'phoneScale',
    'phoneBox',
    'isSizeLimited',
    'motionPreference',
    'reducedMotion',
    'homeGridColumns',
    'homeGridRows'
  ],
  displayWrite: ['setDisplaySize', 'setMotionPreference', 'setHomeGridSize'],
  keybinds: ['onKeybind', 'bindings', 'groups', 'findConflict'],
  keybindsWrite: [],
  lifecycle: ['currentApp', 'onBack', 'goHome', 'consumeDeepLink'],
  lockScreen: ['hasPasscode', 'autoLockPolicy', 'autoLockPolicyChoices'],
  lockScreenWrite: ['setAutoLockPolicy', 'setPasscode', 'clearPasscode'],
  music: [
    'musicSource',
    'musicQueue',
    'musicIndex',
    'musicNowPlaying',
    'musicError',
    'musicPosition',
    'musicRepeat',
    'musicShuffle',
    'musicHasNext',
    'musicHasPrevious',
    'musicStatus',
    'musicVolume',
    'musicMuted',
    'playSource',
    'enqueue',
    'playQueueIndex',
    'removeFromQueue',
    'clearQueue',
    'nextTrack',
    'previousTrack',
    'seekMusic',
    'cycleRepeat',
    'setRepeat',
    'toggleShuffle',
    'pauseMusic',
    'resumeMusic',
    'stopMusic',
    'setMusicVolume',
    'setMusicMuted',
    'toggleMusicMute',
    'nearbyBroadcasts',
    'audibleBroadcasts',
    'mutedBroadcasters',
    'muteAllNearby',
    'muteBroadcaster',
    'unmuteBroadcaster',
    'toggleBroadcasterMute',
    'clearMutedBroadcasters',
    'setMuteAllNearby',
    'toggleMuteAllNearby'
  ],
  navigation: ['currentApp', 'openApp', 'goHome', 'closePhone'],
  notificationSettings: [
    'toastsEnabled',
    'notificationSoundEnabled',
    'badgesEnabled',
    'dndEnabled',
    'appNotificationPolicies',
    'customisedNotificationApps'
  ],
  notificationSettingsWrite: [],
  persisted: [],
  phoneNotification: ['sendNotification', 'dismissNotification', 'toast'],
  /**
   * MICA-286. Both members, and there are only two: read the needle the player typed,
   * answer with hits. Neither reaches anything but the phone's own search sheet, and the
   * app id they act under is pinned rather than named on the wire.
   */
  searchProvider: ['query', 'publish'],
  service: ['call'],
  sound: ['play'],
  sourceUrl: ['sourceUrl', 'refreshSourceUrl'],
  locale: ['locale'],
  streamerMode: ['streamerMode', 'revealGeneration'],
  systemHardware: [
    'charge',
    'signalLevel',
    'cellServiceEnabled',
    'bluetoothEnabled',
    'isBluetoothDiscoverable',
    'soundVolume',
    'soundMuted',
    'volumeStep',
    'ringMode',
    'ringModeChoices',
    'ringtone',
    'ringtoneChoices'
  ],
  systemHardwareWrite: ['setVolume', 'setRingMode', 'previewRingtone'],
  theme: ['themeStore', 'schemeStore', 'isLightMode'],
  themeWrite: ['setThemeSeed', 'setThemeMode', 'resetTheme'],
  timer: [],
  wallpaper: [
    'wallpaperStore',
    'wallpaperBackground',
    'wallpaperNeedsContrast',
    'activeSeed',
    'backgroundForSeed',
    'seedFromImage'
  ],
  wallpaperWrite: ['setWallpaperSeed', 'setPresetWallpaper', 'setWallpaperImage', 'resetWallpaper']
};

/**
 * The members reachable on `facet` from inside a sandbox, or `undefined` if the facet is
 * not reachable at all.
 *
 * Through a `Map` rather than indexing the object: the facet name arrives off the wire, and
 * a plain `FACET_MEMBERS[facet]` lookup would resolve `'toString'` to
 * `Object.prototype.toString` and read as a row of one. A `Map` has no inherited keys to
 * find, so the attacker-controlled string can only ever name a row somebody wrote.
 */
const FACET_MEMBER_INDEX = new Map<string, readonly string[]>(Object.entries(FACET_MEMBERS));

export function membersOfFacet(facet: string): readonly string[] | undefined {
  return FACET_MEMBER_INDEX.get(facet);
}

/**
 * Cheap Levenshtein distance. Every comparison here is against a permission name — under
 * twenty characters, roughly thirty of them — so the naive O(n·m) table is nowhere near
 * worth replacing with anything smarter.
 */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () =>
    Array.from<number>({ length: cols }).fill(0)
  );
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/**
 * The one real permission name exactly one edit from `perm`, if there is one — the shape of
 * a typo (`'notifcations'`), a stray space (`'contacts '`), or the wrong separator
 * (`'system_hardware'`), not a genuinely different word that happens to be short.
 * `undefined` for anything further off, so a made-up name gets a plain warning rather than
 * a wrong guess.
 */
function nearestPermission(perm: string, allPermissions: readonly string[]): string | undefined {
  return allPermissions.find((known) => editDistance(perm, known) === 1);
}

/**
 * `AppManifest['permissions']` is TypeScript-checked only *inside this repo* —
 * `AppPermission` is a union derived from `ALL_PERMISSIONS` `as const`, so a manifest
 * authored here that names something else fails at compile time, and
 * `permissions.test.ts`'s "declares only names in the vocabulary" re-proves it at the
 * value level for every bundled app. Nothing enforces that for a manifest this repo never
 * typechecks — a published add-on, or a dev-registered one — and `defineApp` (`manifest.ts`)
 * is the one place every manifest passes through regardless of source, so that is where
 * this runs (MICA-128).
 *
 * A typo there used to load silently: the permission sheet disclosed nothing for a name
 * matching no row, and the first call to the hook it was *meant* to name threw
 * `AppPermissionError` into the app's `ErrorBoundary` on first use — installed fine, broke
 * later, far from the manifest that caused it. That is the unsafe failure direction, so
 * this only warns, never throws: an unrecognized name is also the shape of honest forward
 * compatibility (an add-on built against a newer phone's vocabulary, opened on an older
 * one), and refusing to load over that would break the legitimate case to catch the
 * illegitimate one.
 *
 * Not gated behind `import.meta.env.DEV` the way `manifest.ts`'s id-casing warning is —
 * that one is cosmetic (the id still normalizes correctly either way); this one is a live
 * bug in waiting, closer to `catalog.ts`'s unconditional warning on a dropped remote-catalog
 * row than to a dev-authoring nicety.
 *
 * Deliberately not exported from `sdk/index.ts`/`sdk/addon.ts` (this file isn't swept by
 * either barrel) — it is `defineApp`'s own internal check, not a capability an app calls.
 *
 * `allPermissions` is a required parameter, not a closed-over import of `ALL_PERMISSIONS`,
 * so `permissions.test.ts` can hand this a deliberately empty or malformed list and prove
 * the guard below actually fires, rather than trusting that it would.
 */
export function validateManifestPermissions(
  id: string,
  permissions: readonly string[],
  allPermissions: readonly string[]
): void {
  // MICA-124 happened once already, elsewhere: a vocabulary list that silently came back
  // empty (a broken import, a bad refactor) made every check reading it vacuously pass — or
  // here, vacuously warn about every single permission, burying the one real typo in noise
  // about apps that did nothing wrong. Refuse to compare against a table that failed to
  // load, rather than trusting it.
  if (!Array.isArray(allPermissions) || allPermissions.length === 0) {
    throw new Error(
      'micaOS App Manifest error: ALL_PERMISSIONS is empty or failed to import. The ' +
        'permission vocabulary itself is broken, so no manifest can be validated against ' +
        "it — that is a build defect, not this app's."
    );
  }

  for (const perm of permissions) {
    if (allPermissions.includes(perm)) continue;
    const suggestion = nearestPermission(perm, allPermissions);
    console.warn(
      `micaOS App Manifest: '${id}' declares permission '${perm}', which is not in ` +
        `ALL_PERMISSIONS.` +
        (suggestion ? ` Did you mean '${suggestion}'?` : '') +
        ` The app still loads, but the Store's permission sheet discloses nothing for this ` +
        `name, and a real hook it was meant to match will throw AppPermissionError on first ` +
        `use instead of being covered by this declaration.`
    );
  }
}
