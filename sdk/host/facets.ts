// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The host contract: every facet a `Host` can answer for, stated once.
 *
 * MICA-179. This interface used to live in `inProcess/facets/index.ts` and was *derived*
 * from the in-process implementations — `contacts: typeof contacts`, fifty-two times over —
 * while forty-five iframe twins derived their own shape from the same modules via
 * `AsTwin<ReturnType<typeof import('../../inProcess/facets/x').x>>`.
 *
 * That inverted the relationship it was supposed to express. The contract reshaped itself to
 * match whichever implementation happened to be written first, so an implementation could not
 * drift from the contract by construction — it *was* the contract — and the twins were
 * checked against an implementation rather than against the thing both sides are meant to
 * honour. Drift between the two sides was invisible for the same reason.
 *
 * It is also what made `sdk/` unable to become a package (MICA-172). `inProcess/` holds
 * seventy of the eighty value edges out of the SDK into `web/` — twenty-odd `services/`
 * modules and the whole `shell/state` tree — so it has to stay on the phone's side of a
 * package boundary. A type-only edge does not save that: `tsc` still has to resolve the
 * specifier, and a package defining its central public type in terms of a module that lives
 * in its consumer is not a package.
 *
 * So the contract is authored here, both facet sets conform to it, and neither derives from
 * the other. A twin that drifts now fails to compile, which is the point.
 *
 * **The members were derived mechanically, not transcribed.** They come from
 * `tsc --emitDeclarationOnly` over the in-process facets, converted verbatim — because a
 * hand-copied contract is a slightly-wrong contract, and "slightly wrong" here means a
 * public type that no longer describes what the shell actually returns. `Facets` is exported
 * from both `@mica/sdk` and `@mica/sdk` (add-on), and `publicSurface.test.ts` holds its
 * membership; if that file goes red, the contract moved rather than merely relocating.
 *
 * Conformance is enforced where it already was: `registerFacet<K extends keyof Facets>(name,
 * fn: Facets[K])` in `current.ts`. Every facet module on both sides passes its implementation
 * through that call, so an implementation narrower than the contract is a compile error at
 * the registration site.
 *
 * Several names below moved here from `inProcess/facets/*` because they would otherwise have
 * left with it — and four of them (`AppActionOptions`, `AppLevelsConfig`, `PersistedOptions`,
 * `CancelTimer`) existed as hand-kept duplicates on both sides. One definition each now.
 */

import type { M3Tokens, sanitizeSeed, seedFromRgbString } from '../lib/m3';
import type { describeMusicError } from '../lib/musicErrors';
import type {
  AccountSearchQuery,
  FollowListQuery,
  FollowPage,
  ReactionTarget
} from '../vocabulary/accounts';
import type {
  RingMode,
  RingModeChoice,
  RingtoneId,
  RingtoneOption,
  SoundEffect
} from '../vocabulary/audio';
import type { SendMoneyInput, SendMoneyOutcome } from '../vocabulary/bank';
import type { CallState, CallStatus } from '../vocabulary/call';
import type {
  MotionPreference,
  ThemeMode,
  ThemeState,
  WallpaperPreset,
  WallpaperState
} from '../vocabulary/display';
import type { CreateListingInput, ListingPage } from '../vocabulary/marketplace';
import type { DeletedMediaItem } from '../vocabulary/media';
import type { IncomingMessage, UIConversation, UIMessage } from '../vocabulary/messages';
import type {
  AudibleBroadcast,
  MusicNowPlaying,
  MusicPosition,
  MusicRepeat,
  MusicSource,
  MusicStatus,
  NearbyBroadcast,
  QueueEntry
} from '../vocabulary/music';
import type { SubmitReportInput } from '../vocabulary/reports';
import type {
  AppEvent,
  AppNotificationPolicy,
  AppUpdate,
  AutoLockPolicy,
  AutoLockPolicyChoice,
  ResolvedKeybindAction,
  RunningApp,
  TimeState,
  ToastMessage
} from '../vocabulary/shell';
import type { MusicError } from '../lib/musicErrors';
import type { CatalogEntry } from '../catalog';
import type { ReactionStore } from '../kit/createReactionStore';
import type { AppComponent, AppManifest, AppPermission, AppDevice } from '../manifest';
import type { KeybindAction } from '@mica/shared/keybinds';
import type {
  Account,
  BankHistorySource,
  Contact,
  Invoice,
  InvoiceActionOutcome,
  FollowStats,
  LeaderboardEntry,
  Listing,
  Mail,
  MediaItem,
  MediaPreview,
  Message,
  NotificationItem,
  PhoneCallLogEntry,
  ReactionSummary,
  Report,
  JobActionOutcome,
  JobView,
  Transaction
} from '@mica/shared/types';
import type { Readable, Subscriber, Unsubscriber, Writable } from 'svelte/store';

/** Toast wording for `useAppAction`'s wrapped work. Moved here from the facet in MICA-179. */
export interface AppActionOptions {
  /** Toast to show when the work succeeds. Omit for actions that speak for themselves. */
  success?: string;
  /** Toast to show when it throws. Defaults to the error's own message. */
  error?: string;
  /** Heading on both toasts, for an app that names itself in its notifications. */
  title?: string;
}

/** One rung of an app's back ladder. */
interface AppLevel {
  /** True while this level is on screen. */
  open: () => boolean;
  /** Take it off screen. Runs when back is pressed and this is the deepest open level. */
  close: () => void;
  /** Header title while this is the deepest open level. */
  title?: string | (() => string);
}

export interface AppLevelsConfig {
  /**
   * The app's registry id — `notes`, `settings`. Not its display name.
   *
   * Required, and it is what stops Back reaching a backgrounded app. Apps are resident, so
   * this ladder stays registered while the app sits hidden; without an owner the dispatcher
   * would hand `back` to whichever app registered last rather than the one on screen.
   */
  appId: string;
  /** Title when nothing is open — the app's own name, usually. */
  title: string | (() => string);
  /** Where back goes once every level is closed. The shell's `onback` prop. */
  onback?: () => void;
  /** Deepest first. Back closes the first one that is open. */
  levels: AppLevel[];
}

/** What `usePhoneNotification` will put on screen. */
export interface SendNotificationOptions {
  title?: string;
  message: string;
  avatar?: string;
  type?: ToastMessage['type'];
  duration?: number;
  onClick?: () => void;
}

/** One owner's block of rebindable actions in Settings > Shortcuts. */
export interface KeybindGroup {
  ownerId: string;
  ownerLabel: string;
  actions: ResolvedKeybindAction[];
}

/** Cancels the timer it came from. Safe to call more than once, and after it has fired. */
export type CancelTimer = () => void;

/** Options for one `usePersisted` store. */
export interface PersistedOptions<T> {
  /**
   * Repair or reject a value before it is stored or handed out.
   *
   * Runs on the value read at startup *and* on every write, so a store cannot be talked into
   * holding something the app would refuse. Stored data outlives the code that wrote it.
   */
  sanitize?: (value: unknown) => T;
  /** Whether the value syncs to the server. Defaults to true. */
  sync?: boolean;
}

/**
 * One hit an app contributed to the phone's own search (MICA-286).
 *
 * `id` need only be unique within the app that published it — the shell keys the row by
 * `<appId>:<id>`. `props` is what `openApp(appId, props)` is called with when the row is
 * tapped, so it is the app's own deep link and nothing the shell interprets; omit it to
 * land on the app root.
 */
export interface ProvidedHit {
  id: string | number;
  title: string;
  subtitle?: string;
  /** Deep-link props for this app, exactly as `useDeepLink` will read them back. */
  props?: Record<string, unknown>;
}

/** One key per facet. The runtime object behind this shape is the `facets` Proxy in `current.ts`. */
export interface Facets {
  account: () => {
    myPhoneNumber: Writable<string>;
    bankBalance: Writable<number>;
    transactions: Writable<Transaction[]>;
    transactionsLoaded: Writable<boolean>;
    /** Where `transactions` came from, and whether the script can say (MICA-241). */
    historySource: Writable<BankHistorySource>;
    citizenid: Writable<string>;
    fetchPhoneNumber: () => Promise<string>;
    fetchBalance: () => Promise<void>;
    fetchTransactions: () => Promise<void>;
    fetchCitizenId: () => Promise<string>;
  };
  accounts: () => {
    getMyAccounts: (app: string) => Promise<{
      rows: Account[];
      limit: number;
    }>;
    getAccounts: (query: { app: string; handle?: string; limit?: number }) => Promise<{
      rows: Account[];
    }>;
    createAccount: (input: {
      app: string;
      handle: string;
      display_name?: string;
    }) => Promise<Account>;
    updateAccount: (
      input: {
        id: number;
      } & Partial<Account>
    ) => Promise<unknown>;
    getFollowStats: (input: {
      app: string;
      account_id: number;
      viewer_account_id?: number;
    }) => Promise<FollowStats>;
    getFollowers: (query: FollowListQuery) => Promise<FollowPage>;
    getFollowing: (query: FollowListQuery) => Promise<FollowPage>;
    searchAccounts: (query: AccountSearchQuery) => Promise<{
      rows: Account[];
      nextCursor: number | null;
    }>;
    followAccount: (input: {
      app: string;
      follower_account_id: number;
      followee_account_id: number;
    }) => Promise<unknown>;
    unfollowAccount: (input: {
      app: string;
      follower_account_id: number;
      followee_account_id: number;
    }) => Promise<unknown>;
    blockAccount: (input: {
      app: string;
      blocker_account_id: number;
      blocked_account_id: number;
    }) => Promise<unknown>;
    unblockAccount: (input: {
      app: string;
      blocker_account_id: number;
      blocked_account_id: number;
    }) => Promise<unknown>;
    getReactionsFor: (target: ReactionTarget) => Promise<Record<number, ReactionSummary>>;
    reactToTarget: (payload: {
      app: string;
      account_id: number;
      target_table: string;
      target_id: number;
      emoji: string;
    }) => Promise<unknown>;
    unreactToTarget: (payload: {
      app: string;
      account_id: number;
      target_table: string;
      target_id: number;
      emoji: string;
    }) => Promise<unknown>;
  };
  admin: () => {
    isAdmin: Writable<boolean>;
    refreshAdmin: () => Promise<void>;
  };
  /** MICA-192: the AGPL §13 source address this server reports, and a way to re-ask. */
  sourceUrl: () => {
    sourceUrl: Writable<string>;
    refreshSourceUrl: () => Promise<void>;
  };
  /**
   * MICA-61: the active locale, and the one way to change it. `setLocale` is for
   * Settings; an add-on may read the locale and never set it (`MEMBER_ALLOWLIST`).
   */
  locale: () => {
    locale: Readable<string>;
    setLocale: (next: string) => void;
  };
  /**
   * MICA-249: streamer mode. `streamerMode` is the player's choice — blur every
   * player-supplied picture until it is tapped; `revealGeneration` bumps whenever a revealed
   * picture should hide again (the flag flips, the foreground app changes, the device
   * closes). `setStreamerMode` is for Settings; an add-on reads both stores and never sets
   * the flag (`FACET_MEMBERS`).
   */
  streamerMode: () => {
    streamerMode: Readable<boolean>;
    revealGeneration: Readable<number>;
    setStreamerMode: (on: boolean) => void;
  };
  appAction: (appId?: string) => {
    busy: Writable<boolean>;
    run: (work: () => unknown, options?: AppActionOptions) => Promise<boolean>;
    /** The toast half of `run`, for a caller whose `work` cannot cross a process boundary (MICA-16 step 4). */
    notify: (n: { type: 'success' | 'error'; title?: string; message: string }) => string;
  };
  appEvents: (appId: string) => {
    /**
     * `T` is an **assertion, not a check**. The bus guarantees `payload` is a plain object and
     * nothing more; narrow it yourself.
     */
    on: <T = Record<string, unknown>>(
      event: string,
      handler: (e: AppEvent<T>) => void
    ) => () => void;
    onAny: (handler: (e: AppEvent) => void) => () => void;
    /** Drop anything buffered, once a fetch has made it redundant. */
    clear: () => void;
  };
  appLevels: (config: AppLevelsConfig) => {
    back: () => void;
    release: () => void;
    /** The deepest open level's title, falling back to the app's own. */
    readonly title: string;
  };
  appRegistry: () => {
    registryStore: {
      subscribe: (
        this: void,
        run: Subscriber<AppManifest[]>,
        invalidate?: () => void
      ) => Unsubscriber;
      registerApp: (manifest: AppManifest, component: AppComponent) => void;
      registerAddOn: (manifest: AppManifest, source?: string) => void;
      unregisterApp: (appId: string) => void;
      getComponent: (appId: string) => AppComponent | undefined;
      isKnownApp: (appId: string) => boolean;
      loadComponent: (appId: string) => Promise<AppComponent | undefined>;
      getAddOnSource: (appId: string) => Promise<string | undefined>;
      isInstalled: (appId: string) => boolean;
      getManifest: (appId: string) => AppManifest | undefined;
      installFromCatalog: (entry: CatalogEntry) => Promise<{
        manifest: AppManifest;
      }>;
      rehydrateSavedRemoteApps: () => Promise<void>;
    };
    /** Add-ons this repo ships uninstalled — what the Store has to offer beyond remotes. */
    bundledAddOns: AppManifest[];
    getFirstBootTime: () => string;
    /** Installed catalog add-ons the catalog has moved past (MICA-74). */
    updatesStore: Readable<AppUpdate[]>;
    /** The same list as a count, for the Store's launcher badge. */
    updateCount: Readable<number>;
  };
  appRegistryWrite: () => {
    /** Re-check the configured catalog. Safe with none configured: the list empties. */
    refreshUpdates: () => Promise<AppUpdate[]>;
    /**
     * Record the permission set a player just accepted for an add-on (MICA-201).
     *
     * The shell's own consent record, written here and nowhere else. The Store calls it
     * after the player answers — an install, or an update whose list grew — and the host
     * refuses any permission a manifest declares without a matching grant, so an
     * installed manifest is no longer its own authorization.
     */
    recordConsent: (appId: string, permissions: readonly AppPermission[]) => void;
    /** What the player granted an add-on, or `undefined` if they were never asked. */
    grantedPermissions: (appId: string) => readonly AppPermission[] | undefined;
    /** Install the catalog's copy of a pending update, through the ordinary verified install path. */
    updateApp: (appId: string) => Promise<AppManifest>;
    installFromCatalog: (entry: CatalogEntry) => Promise<{
      manifest: AppManifest;
    }>;
    registerApp: (manifest: AppManifest, component: AppComponent) => void;
    registerAddOn: (manifest: AppManifest, source?: string) => void;
    unregisterApp: (appId: string) => void;
  };
  appStorageBytes: (appId: string) => number;
  bank: () => {
    sendMoney: (input: SendMoneyInput) => Promise<SendMoneyOutcome>;
    /** Open invoices the player can pay or decline (MICA-240). */
    invoices: Writable<Invoice[]>;
    invoicesLoaded: Writable<boolean>;
    fetchInvoices: () => Promise<void>;
    payInvoice: (id: number) => Promise<InvoiceActionOutcome>;
    declineInvoice: (id: number) => Promise<InvoiceActionOutcome>;
  };
  call: () => {
    callStore: {
      subscribe: (this: void, run: Subscriber<CallState>, invalidate?: () => void) => Unsubscriber;
      startCall: (number: string, name?: string) => Promise<void>;
      endCall: () => Promise<void>;
      answerCall: () => Promise<void>;
      toggleMute: () => Promise<void>;
      toggleSpeaker: () => Promise<void>;
      setIncoming: (number: string, name?: string) => void;
      setStatus: (status: CallStatus) => void;
    };
    startCall: (number: string, name?: string) => Promise<void>;
    endCall: () => Promise<void>;
    answerCall: () => Promise<void>;
    toggleSpeaker: () => Promise<void>;
    callLog: Writable<PhoneCallLogEntry[]>;
    loadCallLog: () => Promise<void>;
  };
  camera: () => {
    isTakingPhoto: Writable<boolean>;
    isPreviewingPhoto: Writable<boolean>;
  };
  clearAppStorage: (appId: string) => void;
  clock: () => {
    /** The current time, updated by the shell. */
    time: Writable<TimeState>;
    /** Whether to render it in 24-hour form. Settings writes it through `useClockWrite`. */
    is24Hour: Writable<boolean>;
    /**
     * The time already rendered in the player's chosen form.
     *
     * Exposed so nothing re-implements the 12/24 branch. The status bar and the Display
     * preview both show a clock, and two formatters would be one preference with two
     * answers.
     */
    formattedTime: Readable<string>;
  };
  clockWrite: () => {
    setIs24Hour: (value: boolean) => void;
  };
  contacts: () => {
    contactsStore: {
      share: (
        payload: Partial<Contact> & {
          name?: string;
          phone: string;
        }
      ) => Promise<void>;
      getDeleted: () => Promise<Contact[]>;
      restore: (id: number) => Promise<boolean>;
      subscribe: (this: void, run: Subscriber<Contact[]>, invalidate?: () => void) => Unsubscriber;
      loaded: {
        subscribe: (this: void, run: Subscriber<boolean>, invalidate?: () => void) => Unsubscriber;
      };
      load: () => Promise<void>;
      add: (
        draft: Omit<Contact, 'id' | 'citizenid' | 'created_at' | 'updated_at'>
      ) => Promise<Contact>;
      update: (row: Contact) => Promise<void>;
      delete: (id: number) => Promise<void>;
      set: (rows: Contact[]) => void;
      patch: (id: number, changes: Partial<Contact>) => void;
    };
    favoriteContacts: Readable<Contact[]>;
    addContact: (
      firstname: string,
      phone: string,
      lastname?: string,
      avatar?: string,
      favorite?: boolean
    ) => Promise<Contact>;
    shareContact: (firstname: string, phone: string, lastname?: string) => Promise<void>;
    /** The "Recently Deleted" list (MICA-75-wiring) — see `services/contacts.ts`. */
    getDeletedContacts: () => Promise<Contact[]>;
    restoreContact: (id: number) => Promise<boolean>;
  };
  deepLink: (appId: string, handle: () => boolean) => void;
  devTools: () => {
    /** Whether the Developer Tools group is currently revealed. */
    devToolsUnlocked: Writable<boolean>;
    unlock: () => void;
    lock: () => void;
  };
  display: () => {
    /**
     * Which frame the app is in (MICA-260): `'phone'` or `'tablet'`. The one thing an
     * app with a single root needs to lay itself out for either; an app that ships
     * `tablet.svelte` already knows.
     */
    device: Readable<AppDevice>;
    /** The frame's design size in CSS px, before the zoom — 400x850 or 1280x800. */
    frame: Readable<{ width: number; height: number }>;
    /** The Display > Phone Size setting, 0-100. */
    displaySize: Writable<number>;
    /** Where the slider starts, so a Reset control needs no second copy of the number. */
    displaySizeDefault: number;
    /** The zoom actually applied, after fitting to the window. Read-only. */
    phoneScale: Readable<number>;
    /** The rendered size in CSS pixels, for showing the player what they picked. */
    phoneBox: Readable<{
      width: number;
      height: number;
    }>;
    /** True when the window is smaller than the setting asks for, and is winning. */
    isSizeLimited: Readable<boolean>;
    /**
     * Motion. `motionPreference` is the player's three-way choice; `reducedMotion` is the
     * resolved answer after the platform's own `prefers-reduced-motion` has been folded
     * in, and is what an app would act on.
     */
    motionPreference: Writable<MotionPreference>;
    motionPreferenceDefault: MotionPreference;
    reducedMotion: Readable<boolean>;
    /** Home Screen Grid — columns/rows, and their adjustable bounds. */
    homeGridColumns: Writable<number>;
    homeGridRows: Writable<number>;
    homeGridColumnsDefault: number;
    homeGridColumnsMin: number;
    homeGridColumnsMax: number;
    homeGridRowsDefault: number;
    homeGridRowsMin: number;
    homeGridRowsMax: number;
  };
  displayWrite: () => {
    setDisplaySize: (size: number) => void;
    setMotionPreference: (preference: MotionPreference) => void;
    /**
     * Applies a new grid size and reflows anything the shrink pushed out of bounds. The
     * setter alone would leave those items structurally valid but unreachable — a shrink
     * is the one time `homeGridItems` needs touching from outside `homeGrid.ts` itself, so
     * this bundles the write and the reflow into one call rather than asking every caller
     * to remember the second step.
     *
     * MICA-121: checked *before* either store is touched, and refused outright if the new
     * size can't hold every item — not applied-then-partially-undone. The grid's own
     * capacity never changes as a side effect of a resize the player never agreed to, and
     * the toast tells them why the stepper in Settings > Display didn't move.
     */
    setHomeGridSize: (columns: number, rows: number) => void;
  };
  highscores: () => {
    submitScore: (app: string, score: number) => Promise<void>;
    getLeaderboard: (app: string) => Promise<LeaderboardEntry[]>;
  };
  /**
   * MICA-228. Every job the player holds, and the two things the phone may do about
   * them. `setActiveJob` and `setDuty` answer with the re-read list on success, and the
   * in-process facet writes it into `jobs` before resolving, so a caller need not fetch
   * again. The name is only ever compared against the player's own list on the server —
   * `unknown_job` is the answer for anything else.
   */
  jobs: () => {
    jobs: Writable<JobView[]>;
    jobsLoaded: Writable<boolean>;
    fetchJobs: () => Promise<void>;
    setActiveJob: (name: string) => Promise<JobActionOutcome>;
    setDuty: (name: string, onDuty: boolean) => Promise<JobActionOutcome>;
  };
  keybinds: () => {
    /**
     * Claim an action for as long as this component is mounted.
     *
     * Pass `appId` for anything an app claims. Apps are resident, so the claim outlives
     * the app being on screen, and without an owner the dispatcher hands the action to
     * whichever app registered last — see the registry note in `shell/state/keybinds.ts`.
     * Only actions carrying their own `when: 'app:…'` context are safe without it, and
     * naming the app costs nothing either way.
     */
    onKeybind: (actionId: string, handler: () => void, appId?: string) => () => void;
    /** Live map of actionId -> bound key. */
    bindings: Readable<Record<string, string>>;
    /**
     * Everything configurable from micaOS's own Shortcuts screen, grouped by owner.
     *
     * Core first (`ownerId: 'core'`), then one group per installed app that declares its
     * own `keybinds`, sorted alphabetically by `ownerLabel`. An app with no declared
     * keybinds contributes no group at all, rather than an empty one.
     */
    groups: Readable<KeybindGroup[]>;
    /**
     * The action already using this key in the same context, if any. Two actions may
     * share a key when their contexts are disjoint — Enter is both Answer Call and the
     * camera shutter, and only one is ever eligible.
     */
    findConflict: (actionId: string, key: string) => KeybindAction | undefined;
  };
  keybindsWrite: () => {
    setBinding: (actionId: string, key: string) => void;
    resetBindings: () => void;
  };
  lifecycle: (appId: string) => {
    currentApp: Writable<RunningApp>;
    /** Claim the physical Back key for as long as this component is mounted. */
    onBack: (handler: () => void) => () => void;
    goHome: () => void;
    /**
     * Mark this app's deep-link props as handled, so they do not fire again. See
     * `useDeepLink`'s doc for the usage contract.
     */
    consumeDeepLink: () => void;
  };
  location: () => {
    shareLocation: () => Promise<{
      id: number;
      media: MediaPreview;
    }>;
    setWaypoint: (x: number, y: number) => Promise<void>;
  };
  lockScreen: () => {
    /** Whether the player has a passcode set at all — Settings' own read, and `PhoneFrame`'s. */
    hasPasscode: Writable<boolean>;
    autoLockPolicy: Writable<AutoLockPolicy>;
    /** A `readable` wrapper, not the bare array — same transport reasoning `ringModeChoices`
     *  documents in `systemHardware.ts`: nothing needs this before hydration. */
    autoLockPolicyChoices: Readable<readonly AutoLockPolicyChoice[]>;
  };
  lockScreenWrite: () => {
    setAutoLockPolicy: (policy: AutoLockPolicy) => void;
    setPasscode: (digits: string) => Promise<void>;
    clearPasscode: () => Promise<void>;
  };
  mail: () => {
    mailStore: {
      markAsRead: (id: number) => Promise<void>;
      archive: (id: number, archive?: boolean) => Promise<void>;
      addReceivedMail: (incoming: Mail) => void;
      subscribe: (this: void, run: Subscriber<Mail[]>, invalidate?: () => void) => Unsubscriber;
      loaded: {
        subscribe: (this: void, run: Subscriber<boolean>, invalidate?: () => void) => Unsubscriber;
      };
      load: () => Promise<void>;
      add: (draft: Omit<Mail, 'id'>) => Promise<Mail>;
      update: (row: Mail) => Promise<void>;
      delete: (id: number) => Promise<void>;
      set: (rows: Mail[]) => void;
      patch: (id: number, changes: Partial<Mail>) => void;
    };
    unreadMailCount: Readable<number>;
    deleteMail: (id: number) => Promise<void>;
    markAsRead: (id: number) => Promise<void>;
    archiveMail: (id: number, archiveState?: boolean) => Promise<void>;
    addReceivedMail: (newMail: Mail) => void;
  };
  marketplace: () => {
    feedStore: Writable<ListingPage>;
    mineStore: Writable<ListingPage>;
    loadFeed: () => Promise<void>;
    searchListings: (q: string) => Promise<ListingPage>;
    loadMine: () => Promise<void>;
    viewListing: (id: number) => Promise<
      | (Listing & {
          contactPhone: string | null;
          isOwn: boolean;
        })
      | null
    >;
    postListing: (input: CreateListingInput) => Promise<Listing>;
    markSold: (id: number) => Promise<boolean>;
    removeListing: (id: number) => Promise<boolean>;
  };
  media: () => {
    media: {
      full: (mediaId: number) => Promise<MediaItem>;
      hydrate: (item: MediaPreview) => void;
      receive: (mediaId?: number) => Promise<void>;
      load: (filter?: Record<string, unknown>) => Promise<void>;
      add: (
        draft: Omit<MediaItem, 'id' | 'citizenid' | 'created_at' | 'updated_at'>
      ) => Promise<MediaItem>;
      setThumbnail: (mediaId: number, thumbnail: string) => Promise<boolean>;
      delete: (mediaId: number) => Promise<void>;
      dropNearby: (mediaId: number) => Promise<{
        count: number;
      }>;
      shareLocation: () => Promise<{
        id: number;
        media: MediaPreview;
      }>;
      setWaypoint: (x: number, y: number) => Promise<void>;
      getDeleted: () => Promise<DeletedMediaItem[]>;
      restore: (mediaId: number) => Promise<boolean>;
      loaded: Readable<boolean>;
      hasMore: Readable<boolean>;
      loadMore(): Promise<boolean>;
      prepend(row: MediaItem): void;
      replace(row: MediaItem): void;
      remove(id: number): void;
      subscribe(this: void, run: Subscriber<MediaItem[]>, invalidate?: () => void): Unsubscriber;
    };
    capturePhoto: (data: string, thumbnail?: string) => Promise<MediaItem>;
    deletePhoto: (id: number) => Promise<void>;
    dropNearby: (mediaId: number) => Promise<{
      count: number;
    }>;
    /**
     * One row with its bytes.
     *
     * Named on the facet rather than left to `media.full` on the store, because the store
     * an iframe gets is a `Readable` and has no methods on it at all. Every surface that
     * hands over an *original* rather than a tile needs this now that the list read carries
     * neither (MICA-110) — the avatar picker and the wallpaper picker both do, and both
     * are reachable from a sandboxed app.
     */
    fullMedia: (mediaId: number) => Promise<MediaItem>;
    /**
     * The "Recently Deleted" list (MICA-75-wiring). Named here rather than left to
     * `media.getDeleted`/`media.restore` on the store above, for the same reason
     * `fullMedia` already is: the store an iframe gets is a `Readable` with no methods on
     * it at all, so anything an add-on needs to call has to be its own facet member.
     */
    getDeletedMedia: () => Promise<DeletedMediaItem[]>;
    restoreMedia: (mediaId: number) => Promise<boolean>;
  };
  messages: () => {
    conversationsStore: {
      subscribe: (
        this: void,
        run: Subscriber<UIConversation[]>,
        invalidate?: () => void
      ) => Unsubscriber;
      loaded: {
        subscribe: (this: void, run: Subscriber<boolean>, invalidate?: () => void) => Unsubscriber;
      };
      /**
       * Whether the server said there is another page of threads behind the one held
       * (MICA-204).
       *
       * Declared beside `loaded` because they answer adjacent questions and a list that has
       * one without the other cannot render honestly: `loaded` separates "still arriving"
       * from "there is nothing here", and this separates "that is all of it" from "there is
       * more, ask". Without it the inbox could only ever show its first page and would look
       * complete doing it.
       */
      hasMore: {
        subscribe: (this: void, run: Subscriber<boolean>, invalidate?: () => void) => Unsubscriber;
      };
      messages: {
        subscribe: (
          this: void,
          run: Subscriber<Record<number, UIMessage[]>>,
          invalidate?: () => void
        ) => Unsubscriber;
      };
      activeConversationId: {
        subscribe: (
          this: void,
          run: Subscriber<number | null>,
          invalidate?: () => void
        ) => Unsubscriber;
      };
      setActiveConversationId: (id: number | null) => void;
      loadConversations: () => Promise<void>;
      /**
       * Append the next page of threads, walking the cursor `conversations:get` accepts
       * (MICA-197/MICA-204). Resolves to whether anything arrived.
       *
       * Paired with `hasMore` rather than usable on its own: it is a no-op once the cursor
       * has run out, so a caller with no way to ask whether a page exists can only find out
       * by asking for one.
       */
      loadMoreConversations: () => Promise<boolean>;
      loadMessages: (conversationId: number) => Promise<void>;
      /**
       * Whether an older page of a held thread exists behind what is loaded, keyed by
       * conversation id (MICA-212). Absent means nothing is known, which the app reads
       * as false.
       */
      hasOlderMessages: {
        subscribe: (
          this: void,
          run: Subscriber<Record<number, boolean>>,
          invalidate?: () => void
        ) => Unsubscriber;
      };
      /**
       * Prepend the next older page of a held thread, walking the cursor `messages:get`
       * hands back (MICA-212). Resolves to whether anything arrived, and is a no-op for a
       * thread that is not held or has no page left — pair it with `hasOlderMessages`.
       */
      loadOlderMessages: (conversationId: number) => Promise<boolean>;
      sendMessage: (
        conversationId: number,
        message: string,
        attachments?: {
          photo_id: number;
          attachment?: string;
        }[],
        replyToId?: number | null
      ) => Promise<Message | null>;
      editMessage: (
        conversationId: number,
        messageId: number,
        message: string
      ) => Promise<{
        message: string;
        edited?: boolean;
      } | null>;
      deleteMessage: (conversationId: number, messageId: number) => Promise<boolean>;
      startConversation: (phone: string, isGroup?: boolean) => Promise<UIConversation | null>;
      markAsRead: (conversationId: number) => Promise<void>;
      archiveConversation: (conversationId: number, archive?: boolean) => Promise<void>;
      deleteConversation: (conversationId: number) => Promise<void>;
      renameConversation: (conversationId: number, name: string) => Promise<void>;
      addReceivedMessage: (incoming: IncomingMessage) => void;
    };
    unreadMessagesCount: Readable<number>;
    sendMessage: (conversationId: number, text: string) => Promise<Message | null>;
    addReceivedMessage: (message: IncomingMessage) => void;
    /**
     * Open Messages and start (or resume) a conversation with a bare phone number —
     * no saved Contact required. See MICA-15.
     */
    startText: (phone: string) => void;
    /** Reactions on a message (MICA-143), on the shared primitive — see `conversations.ts`. */
    messageReactions: ReactionStore;
    loadMessageReactions: (ids: number[]) => Promise<void>;
    toggleMessageReaction: (messageId: number, emoji: string) => Promise<void>;
  };
  music: () => {
    /** What is loaded, as ids. `null` when nothing is. */
    musicSource: Readable<MusicSource | null>;
    /** Everything queued, in play order. */
    musicQueue: Readable<QueueEntry[]>;
    /** Which row of `musicQueue` is loaded, or `-1` when none is. */
    musicIndex: Readable<number>;
    /**
     * What the embed reports it is actually playing — the title and the video id, plus a
     * position inside a playlist row. `null` until it says anything, and it may never:
     * every label an app draws from this needs a fallback to the id.
     */
    musicNowPlaying: Readable<MusicNowPlaying | null>;
    /**
     * Why the loaded track will not play, or `null`. Set together with
     * `musicStatus: 'error'`, so an app can render one or the other and never both.
     */
    musicError: Readable<MusicError | null>;
    /**
     * Where the player says it is, in seconds. `duration` is `0` until it reports one and
     * stays `0` for a live stream, which is the signal to draw no scrubber rather than a
     * scrubber that cannot move.
     */
    musicPosition: Readable<MusicPosition>;
    /** Whether a finished queue repeats, repeats one track, or stops. */
    musicRepeat: Readable<MusicRepeat>;
    musicShuffle: Readable<boolean>;
    /**
     * Whether `nextTrack`/`previousTrack` would go anywhere.
     *
     * Exposed because a transport that cannot ask this has to offer the control anyway,
     * and at the end of a queue that is not repeating `nextTrack` *stops* rather than
     * advancing — a button whose label says one thing and whose effect is another.
     * `musicHasNext` is `pickNext() !== null`, the same function the button calls, rather
     * than a second opinion about it; `musicHasPrevious` is true whenever anything is
     * loaded, because from the first row Previous restarts the track.
     */
    musicHasNext: Readable<boolean>;
    musicHasPrevious: Readable<boolean>;
    /** What the phone has been asked to do with it. */
    musicStatus: Readable<MusicStatus>;
    /** Music's own volume, 0–1 — not the phone's UI-sound volume. */
    musicVolume: Writable<number>;
    /**
     * Whether the music channel is silenced. Independent of the phone's UI-sound mute, and
     * of whether anything is playing — a mute stops the sound, never the queue.
     */
    musicMuted: Writable<boolean>;
    /**
     * Is this string a YouTube video or playlist link? Pure, synchronous, and answered
     * locally on both sides of the add-on seam — ask this before `playSource` so the app
     * can report a bad paste in its own words.
     */
    canPlay: (input: string) => boolean;
    /**
     * Play it now: inserted after whatever is playing, and jumped to. Silently drops
     * anything `canPlay` would have refused.
     */
    playSource: (input: string) => void;
    /** Add it to the end of the queue without interrupting anything, and without starting. */
    enqueue: (input: string) => void;
    /** Play a specific row. The row already playing restarts. */
    playQueueIndex: (index: number) => void;
    /** Drop a row by its `key`. Removing the row that is playing falls through to the next. */
    removeFromQueue: (key: string) => void;
    /** Empty the queue and stop. `stopMusic` alone keeps it. */
    clearQueue: () => void;
    nextTrack: () => void;
    previousTrack: () => void;
    /** Move the playhead, in seconds. Bounded by the reported duration; does not resume. */
    seekMusic: (to: number) => void;
    /** Off, then all, then one. */
    cycleRepeat: () => void;
    setRepeat: (mode: MusicRepeat) => void;
    toggleShuffle: () => void;
    /** The still frame for a video id, or `null`. A plain image; no API key, no script. */
    thumbnailUrlFor: (videoId: string | null | undefined) => string | null;
    /**
     * One phrase for a failure, shared so three screens cannot invent three wordings for
     * the same refusal. Pure and synchronous on both sides of the seam.
     */
    describeMusicError: typeof describeMusicError;
    pauseMusic: () => void;
    resumeMusic: () => void;
    stopMusic: () => void;
    /** Set the level, 0–1. Zero mutes and moving off zero unmutes, like the system slider. */
    setMusicVolume: (value: number) => void;
    setMusicMuted: (muted: boolean) => void;
    /** Silence music without disturbing the level it comes back to. */
    toggleMusicMute: () => void;
    /**
     * Other people's music (MICA-111 phase 2), and everything an app may do about it.
     *
     * Read-and-mute, and nothing else, because there is nothing else to offer: a broadcast
     * has no queue you can see, no position you may move and no error you could fix. The
     * transport above is for this phone's own playback and deliberately does not accept a
     * broadcaster id — an app that could pause a stranger's music would be an app that
     * could pause a stranger's music.
     */
    nearbyBroadcasts: Readable<NearbyBroadcast[]>;
    /** The ones actually playing: not muted, in earshot, and inside the cap. */
    audibleBroadcasts: Readable<AudibleBroadcast[]>;
    /**
     * How many play at once. Exposed so a screen can *say* the rule — "playing the closest
     * three" — rather than leaving a person to discover it by counting.
     */
    maxAudibleBroadcasts: number;
    /** Broadcaster tokens this phone refuses to play. Never server ids — see `useMusic`. */
    mutedBroadcasters: Readable<string[]>;
    /** Whether every nearby broadcast is silenced, whoever it belongs to. */
    muteAllNearby: Readable<boolean>;
    muteBroadcaster: (token: string) => void;
    unmuteBroadcaster: (token: string) => void;
    toggleBroadcasterMute: (token: string) => void;
    /** Forget every individual mute. Leaves `muteAllNearby` alone; it is its own switch. */
    clearMutedBroadcasters: () => void;
    setMuteAllNearby: (on: boolean) => void;
    toggleMuteAllNearby: () => void;
  };
  navigation: () => {
    currentApp: Writable<RunningApp>;
    openApp: (appName: string, props?: Record<string, unknown>) => void;
    goHome: () => void;
    closePhone: () => void;
  };
  notificationSettings: () => {
    toastsEnabled: Writable<boolean>;
    notificationSoundEnabled: Writable<boolean>;
    badgesEnabled: Writable<boolean>;
    dndEnabled: Writable<boolean>;
    appNotificationPolicies: Writable<{
      [x: string]: AppNotificationPolicy;
    }>;
    customisedNotificationApps: Readable<string[]>;
    appPolicyStore: (appId: string) => Readable<AppNotificationPolicy>;
  };
  notificationSettingsWrite: () => {
    setToastsEnabled: (value: boolean) => void;
    setNotificationSoundEnabled: (value: boolean) => void;
    setBadgesEnabled: (value: boolean) => void;
    setDndEnabled: (value: boolean) => void;
    setAppNotificationPolicy: (appId: string, patch: Partial<AppNotificationPolicy>) => void;
    clearAppNotificationPolicy: (appId: string) => void;
  };
  notifications: (appId?: string) => {
    notificationsStore: Readable<NotificationItem[]>;
    unreadCount: Readable<number>;
    totalUnread: Readable<number>;
    /** Shared across every caller: the shade is one list, so the first fetch is one fetch. */
    loaded: Writable<boolean>;
    load: () => Promise<void>;
    markRead: (ids: number[]) => Promise<void>;
    clear: (ids: number[]) => Promise<void>;
    clearAll: (targetAppId?: string) => Promise<void>;
  };
  onAppForeground: (appId: string, handler: () => void) => () => void;
  onAppUnmount: (handler: () => void) => void;
  persisted: <T>(
    appId: string,
    key: string,
    initial: T,
    options?: PersistedOptions<T>
  ) => Writable<T>;
  phoneNotification: () => {
    sendNotification: (options: SendNotificationOptions) => string;
    dismissNotification: (id: string) => void;
    toast: {
      subscribe: (
        this: void,
        run: Subscriber<ToastMessage[]>,
        invalidate?: () => void
      ) => Unsubscriber;
      show: (
        options: Partial<ToastMessage> & {
          message: string;
          soundHandled?: boolean;
        }
      ) => string;
      dismiss: (id: string) => void;
      archive: (id: string) => Promise<void>;
      pauseDismiss: (id: string) => void;
      resumeDismiss: (id: string, delay?: number) => void;
      clear: () => void;
      showIncomingMessage: (options: {
        sender: string;
        message: string;
        avatar?: string;
        onReply: (replyText: string) => void | Promise<void>;
        onClick?: () => void | Promise<void>;
      }) => string;
      showContactShare: (options: {
        name: string;
        phone: string;
        avatar?: string;
        senderLabel: string;
        onAccept: () => void | Promise<void>;
        onDecline?: () => void | Promise<void>;
        onClick?: () => void | Promise<void>;
      }) => string;
      showCall: (options: {
        name?: string;
        number: string;
        breakThrough?: boolean;
        onAccept: () => void | Promise<void>;
        onDecline?: () => void | Promise<void>;
        onExpire?: () => void | Promise<void>;
      }) => string;
      showMail: (options: { sender: string; subject: string; onClick?: () => void }) => string;
    };
  };
  report: () => {
    submit: (input: SubmitReportInput) => Promise<void>;
  };
  reports: () => {
    pendingReports: Writable<Report[]>;
    resolvedReports: Writable<Report[]>;
    pendingReportCount: Readable<number>;
    loadPendingReports: () => Promise<void>;
    loadReportHistory: () => Promise<void>;
    resolveReport: (id: number, action: 'moderate' | 'dismiss') => Promise<void>;
    reopenReport: (id: number) => Promise<void>;
  };
  /**
   * MICA-286: an app's own rows in the phone's search, without the app handing a function
   * across the add-on seam.
   *
   * The seam carries data one way — the shell pushes store values into a frame and answers
   * calls out of it — and has no shell-to-frame call direction at all, so
   * `SearchProvider.search` (`web/src/shell/state/searchResults.ts`) is not something a
   * sandboxed add-on could ever be. This inverts it into the two shapes the seam already
   * has: `query` is a store the shell pushes, `publish` is a call the frame makes.
   *
   * `query` is the current needle, already trimmed and lower-cased — the same string
   * `searchEverything` hands a provider, so an app matches against one spelling rather
   * than inventing its own. It is `''` whenever nothing is being searched.
   *
   * `publish` states which needle the hits answer, so the shell can drop a reply for a
   * query the player has already typed past. The app searches its **own** rows inside its
   * own process; nothing but the hits it chose crosses the seam.
   */
  searchProvider: (appId: string) => {
    query: Readable<string>;
    publish: (needle: string, hits: readonly ProvidedHit[]) => void;
  };
  service: (serviceId: string) => {
    id: string;
    /**
     * Call one action and wait for the reply.
     *
     * `defaultValue` behaves as it does everywhere else in the SDK: a failed round trip
     * resolves to it rather than throwing, so a missing server half degrades to an empty
     * list instead of a crashed app. Omit it when a failure should surface — a write
     * wrapped in `useAppAction` wants the error so it can toast it.
     */
    call: <T = unknown>(action: string, data?: unknown, defaultValue?: T) => Promise<T>;
  };
  sound: () => {
    /** Play one of the phone's built-in effects. Silent while muted. */
    play: (effect: SoundEffect) => void;
  };
  storage: (appId: string) => {
    getItem: <T = unknown>(key: string, defaultValue?: T) => T | null;
    setItem: <T = unknown>(key: string, value: T) => void;
    removeItem: (key: string) => void;
    /**
     * Serves the iframe `persisted` twin's `markUnsynced` (MICA-16 step 4): an add-on
     * cannot import `settingsSync` directly, so this is the one member of the facet that
     * reaches it on the add-on's behalf.
     */
    markUnsynced: (key: string) => void;
    /**
     * The wall-side route for `clearAppStorage` (MICA-16 step 4): that facet is a bare
     * function, not a factory, so a `remoteCall` naming it has no member to call. This
     * member is what the iframe twin's `clearAppStorage(appId)` actually reaches.
     */
    clear: () => void;
  };
  systemHardware: () => {
    charge: Writable<number>;
    signalLevel: Writable<number>;
    cellServiceEnabled: Writable<boolean>;
    bluetoothEnabled: Writable<boolean>;
    isBluetoothDiscoverable: Readable<boolean>;
    soundVolume: Writable<number>;
    soundMuted: Writable<boolean>;
    /** How far one physical volume-button press moves the volume, in whole percent. */
    volumeStep: Writable<number>;
    volumeStepChoices: readonly [1, 2, 5, 10, 20];
    /** The ringer switch: `'normal' | 'vibrate' | 'silent'`. MICA-62. */
    ringMode: Writable<RingMode>;
    /**
     * The choice lists are `readable` wrappers rather than the bare arrays, and that is a
     * transport decision, not a second source of truth — `shell/state/audio.ts` still owns
     * the one list. A plain value on a facet has to be hand-carried through
     * `AddOnConstants` (as `volumeStepChoices` is, because the first paint needs it
     * synchronously); a store rides the generic subscribe path an iframe twin already has.
     * Nothing renders a ringer picker before hydration, so the store is the cheaper half
     * of that trade.
     */
    ringModeChoices: Readable<readonly RingModeChoice[]>;
    ringtone: Writable<RingtoneId>;
    ringtoneChoices: Readable<readonly RingtoneOption[]>;
  };
  systemHardwareWrite: () => {
    /**
     * Developer Tools' battery slider used to call `charge.set()` directly; that bypassed
     * this permission entirely, the same gap `useClockWrite`'s `setIs24Hour` closed for
     * `is24Hour`.
     */
    setCharge: (level: number) => void;
    setSignal: (level: number) => void;
    toggleCellService: () => void;
    toggleBluetooth: () => void;
    setVolume: (val: number) => void;
    toggleMute: () => void;
    setVolumeStep: (percent: number) => void;
    setRingMode: (mode: RingMode) => void;
    setRingtone: (id: RingtoneId) => void;
    /**
     * Audition a tone from the settings pane. Ignores the ring mode (that is the control
     * being configured) but not the mute or the volume — see `SoundService.preview`.
     */
    previewRingtone: (id: RingtoneId) => void;
  };
  theme: () => {
    themeStore: Writable<ThemeState>;
    schemeStore: Readable<M3Tokens>;
    isLightMode: Readable<boolean>;
    defaultTheme: ThemeState;
    /** Convert an `rgb()`/`rgba()` string — what a color picker emits — into a seed. */
    seedFromRgbString: typeof seedFromRgbString;
    sanitizeSeed: typeof sanitizeSeed;
  };
  themeWrite: () => {
    setThemeSeed: (seed: string) => void;
    setThemeMode: (mode: ThemeMode) => void;
    resetTheme: () => void;
  };
  timer: () => {
    after: (ms: number, handler: () => void) => CancelTimer;
    every: (ms: number, handler: () => void) => CancelTimer;
    clearAll: () => void;
  };
  wallpaper: () => {
    wallpaperStore: Writable<WallpaperState>;
    wallpaperBackground: Readable<string>;
    /** Whether text drawn over the wallpaper needs the `.text-on-wallpaper` treatment. */
    wallpaperNeedsContrast: Readable<boolean>;
    activeSeed: Readable<string>;
    backgroundForSeed: (seed: string, mode: ThemeMode) => string;
    seedFromImage: (source: string) => Promise<string | null>;
    presets: readonly WallpaperPreset[];
    defaultWallpaper: WallpaperState;
  };
  wallpaperWrite: () => {
    setWallpaperSeed: (seed: string) => void;
    setPresetWallpaper: (preset: WallpaperPreset) => void;
    setWallpaperImage: (image: string, seed?: string) => void;
    resetWallpaper: () => void;
  };
}
