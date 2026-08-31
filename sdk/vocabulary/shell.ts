import type { KeybindAction } from '@gphone/shared/keybinds';
import type { CatalogEntry } from '../catalog';

/**
 * The phone's own nouns — navigation, app events, updates, keybinds, the lock, the clock,
 * notifications and toasts. MICA-172 — see `./accounts.ts` for why these are declared
 * inside the package rather than imported back out of `shell/state/`.
 *
 * These are the ones the inversion showed up worst on: six of them are already published
 * from `sdk/index.ts` (`AppEvent`, `AppUpdate`, `AppUpdateKind`, `ResolvedKeybindAction`,
 * `RunningApp`, `ToastMessage`, `TimeState`), so the SDK was re-exporting its own public
 * contract *out of its consumer* — `export type { RunningApp } from '../shell/state/navigation'`.
 * The published names are unchanged; only the module behind each one moved.
 *
 * `AppUpdate` names `CatalogEntry`, which was already inside the package, and
 * `ResolvedKeybindAction` extends `@gphone/shared/keybinds` — the wire definition the server shares.
 * Neither acquired a new dependency by moving.
 */

/** One event delivered through `useAppEvents`. */
export interface AppEvent<T = Record<string, unknown>> {
  app: string;
  event: string;
  payload: T;
  at: number;
  /** Arrived before this handler existed, and is being replayed. */
  replayed: boolean;
}

export type AppUpdateKind =
  /** The catalog's version is strictly newer than what is installed. */
  | 'newer'
  /**
   * The two versions differ and cannot be ordered — one of them is not a version this can
   * parse (`lib/phone/semver.ts`). Surfaced rather than swallowed: an operator who publishes
   * `nightly` still republished *something*, and silently calling that "up to date" is the
   * failure that ticket is about. It is shown as a mismatch, never as "newer".
   */
  | 'unordered';

export interface AppUpdate {
  appId: string;
  /** The installed app's name, so a caller can say what is out of date without a second lookup. */
  name: string;
  installedVersion: string | undefined;
  availableVersion: string;
  kind: AppUpdateKind;
  /** The catalog entry to install. Carries the fresh `sha256`, so the update re-verifies like any install. */
  entry: CatalogEntry;
}

/**
 * A `KeybindAction` tagged with who owns it, for grouping in Settings > Shortcuts.
 * `ownerId: 'core'` for the static list; otherwise the declaring app's id.
 */
export interface ResolvedKeybindAction extends KeybindAction {
  ownerId: string;
  ownerLabel: string;
}

export type AutoLockPolicy = 'onClose' | 'onTimeout' | 'never';

export interface AutoLockPolicyChoice {
  readonly id: AutoLockPolicy;
  readonly label: string;
  readonly description: string;
}

export interface RunningApp {
  /**
   * The app's registry id — `notes`, `settings`. Not its display name.
   *
   * It was called `name`, which read as the human-facing one and got used that way:
   * `ErrorBoundary` printed it, so a crash in Admin said "The admin app encountered a
   * problem". The manifest holds the display name; this is the key you look it up with.
   */
  id: string;
  props: Record<string, unknown>;
}

/**
 * Where an interruption came from, which is what decides whether Do Not Disturb and the
 * per-app mutes apply to it.
 *
 * - `feedback` — a toast confirming something the player just did. Never suppressed; a
 *   confirmation you cannot see is an invisible one.
 * - `app` — an unsolicited arrival attributed to an app. The only source policy fully governs.
 * - `call` — an incoming call. Its banner is never suppressed.
 * - `system` — the shell itself and the server speaking directly to a player through
 *   `notifyPlayer` (`server/lib/shell.ts`), which is the channel moderation and admin commands
 *   reach somebody on. Exempt from everything. An admin warning a player can mute is not a
 *   warning, and the player would never know it had been sent.
 */
export type NotificationSource = 'feedback' | 'app' | 'call' | 'system';

export interface AppNotificationPolicy {
  banner: boolean;
  sound: boolean;
  badge: boolean;
}

/** Hours and minutes, as rendered by `useClock`. */
export interface TimeState {
  hours: number;
  minutes: number;
}

export type ToastType = 'info' | 'success' | 'warning' | 'error' | 'message' | 'call' | 'contact';

export interface ToastAction {
  label: string;
  variant?: 'primary' | 'secondary' | 'success' | 'danger';
  onClick: (textInput?: string) => void | Promise<void>;
}

/** A single toast, as shown by `usePhoneNotification().toast`. */
export interface ToastMessage {
  id: string;
  /** The drawer notification this toast created, if any — lets a swipe-to-archive act on the right row. */
  notificationId?: number;
  app?: string;
  title?: string;
  message: string;
  type: ToastType;
  duration?: number;
  avatar?: string;
  sender?: string;
  deepLink?: string;
  persist?: boolean;
  actions?: ToastAction[];
  hasReplyInput?: boolean;
  replyPlaceholder?: string;
  onReply?: (replyText: string) => void | Promise<void>;
  onClick?: () => void | Promise<void>;
  /**
   * What kind of interruption this is, which is what decides whether Do Not Disturb and the
   * per-app mutes apply to it (`shell/state/notificationPolicy.ts`).
   *
   * Defaults to `'feedback'` — a toast confirming something the player just did, which is never
   * suppressed. Every *arrival* path has to say so, and they all live in `nuiMessages.ts` and
   * the helpers at the bottom of `shell/state/toast.ts`.
   */
  source?: NotificationSource;
  /** For a call: it rang despite DND, because of a favourite or a repeat. */
  breakThrough?: boolean;
  /**
   * Run when the toast times out on its own, as opposed to being dismissed or actioned.
   *
   * Exists because an expiring toast can leave state behind: an unanswered call toast
   * vanished after 12s while `callStore.status` stayed `'incoming'`, so the phone sat
   * open and focused showing a call with no way to end it.
   */
  onExpire?: () => void | Promise<void>;
}
