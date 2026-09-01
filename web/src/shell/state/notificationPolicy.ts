// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get, type Readable } from 'svelte/store';
import { usePersisted } from '../../../../sdk/host/usePersisted';
import type { AppNotificationPolicy, NotificationSource } from '../../../../sdk/vocabulary/shell';
import { toastsEnabled, notificationSoundEnabled, badgesEnabled } from './notificationSettings';
import { contacts } from '../../services/contacts';

/**
 * Do Not Disturb, and per-app notification control (MICA-63).
 *
 * **The decision this file encodes: policy is evaluated on the phone, never on the server.**
 *
 * A notification here is two separate things that the codebase already keeps apart — a *row*
 * (`gphone_notifications`, written by `persistNotificationsAsync` in `server/lib/appEvents.ts`
 * whether or not the player is online) and an *interruption* (the toast `ToastHost` paints and
 * the sound `audio.play` makes). Muting is a statement about the second one only. So the server
 * keeps writing the row and keeps pushing the envelope, and this module decides whether the
 * phone interrupts anybody about it.
 *
 * Enforcing it server-side would have to suppress the push, and the push is what carries the
 * data — an app's store is fed from the same envelope that raises the toast. Suppressing it
 * would mute the app's *contents*, not its notifications: a muted Blabber would stop showing
 * new posts, not merely stop announcing them. `pushMany` is also built to take one
 * `getAllPlayers()` snapshot for a whole fan-out, and a server-side check would put a
 * per-recipient preference lookup back inside that loop.
 *
 * This is the same shape as the `notifications` permission, which AGENTS.md §8 already
 * describes as gating "the toast, not the data" — and for the same reason. The one difference
 * worth naming: the permission is a *disclosure* boundary and this is a *preference*, so a
 * modified client ignoring it wins nothing it did not already have. There is no threat model
 * in which a player suppressing their own banner is an attack, which is precisely why the
 * simplest enforcement point is also the correct one.
 *
 * What that buys, concretely: the row is in the shade when you look for it, the badge count is
 * whatever you asked it to be, and nothing about a mute is destructive. Turning DND off does
 * not leave a hole where four hours of notifications should be.
 */

/** The three axes a player can control, matching the three switches Settings already had. */
export type NotificationChannel = 'banner' | 'sound' | 'badge';

/**
 * Where an interruption came from. This is the field that decides whether policy applies at
 * all, and each value is a deliberate exemption rather than a category label.
 *
 * - `feedback` — the phone confirming something the player just did ("Contact added",
 *   "Report sent"). Not a notification: nobody is being interrupted, they are being answered.
 *   **The default**, so a toast that forgets to classify itself still shows. That direction is
 *   chosen on purpose: an unhonoured mute is a bug report, a silently swallowed notification
 *   is an invisible one.
 * - `app` — an unsolicited arrival attributed to an app. The only source policy fully governs.
 * - `call` — an incoming call. See `notificationAllows` for why its banner is never suppressed.
 * - `system` — the shell itself and the server speaking directly to a player through
 *   `notifyPlayer` (`server/lib/shell.ts`), which is the channel moderation and admin commands
 *   reach somebody on. Exempt from everything. An admin warning a player can mute is not a
 *   warning, and the player would never know it had been sent.
 */
const DEFAULT_APP_POLICY: AppNotificationPolicy = { banner: true, sound: true, badge: true };

type PolicyMap = Record<string, AppNotificationPolicy>;

/**
 * Stored data outlives the code that wrote it (`usePersisted`'s own note), and this key holds a
 * nested object rather than a scalar — so every level is rebuilt rather than trusted. An entry
 * that is not an object, or a channel that is not a boolean, falls back to allowed.
 */
const sanitizePolicyMap = (value: unknown): PolicyMap => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: PolicyMap = {};
  for (const [appId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    out[appId] = {
      banner: entry.banner !== false,
      sound: entry.sound !== false,
      badge: entry.badge !== false
    };
  }
  return out;
};

/**
 * Do Not Disturb: deliver everything, interrupt about nothing.
 *
 * Deliberately not airplane mode's neighbour in behaviour, only in placement — airplane mode
 * takes the phone off the network so nothing arrives, which is the thing the ticket says DND
 * is not.
 */
export const dndEnabled = usePersisted<boolean>('settings', 'dnd_enabled', false, {
  sanitize: (value) => value === true
});

/**
 * Per-app overrides, keyed by app id. Absent means "allowed on every channel" — the map holds
 * only what the player has actually changed, so a newly installed app is not silently governed
 * by a stale entry and the stored value stays small.
 *
 * An `ext_<resource>` group is an app id for this purpose, which is the whole reason the map is
 * keyed by string rather than by the registry: a third-party resource flooding the shade is the
 * case a server owner hits first, and grouping already gave each one an identity to mute.
 */
export const appNotificationPolicies = usePersisted<PolicyMap>(
  'settings',
  'app_notification_policies',
  {},
  { sanitize: sanitizePolicyMap }
);

export const policyForApp = (appId: string | undefined, map: PolicyMap): AppNotificationPolicy =>
  (appId ? map[appId] : undefined) ?? DEFAULT_APP_POLICY;

/** A live view of one app's three switches, for the Settings and AppInfo panes. */
export const appPolicyStore = (appId: string): Readable<AppNotificationPolicy> =>
  derived(appNotificationPolicies, ($map) => policyForApp(appId, $map));

/**
 * Change one channel for one app.
 *
 * Writes the full triple rather than a partial, so a stored entry is always complete and
 * reading one never has to merge against the default.
 */
export const setAppNotificationPolicy = (
  appId: string,
  patch: Partial<AppNotificationPolicy>
): void => {
  appNotificationPolicies.update(($map) => ({
    ...$map,
    [appId]: { ...policyForApp(appId, $map), ...patch }
  }));
};

/** Forget an app's overrides — used when an app is uninstalled, so a reinstall starts clean. */
export const clearAppNotificationPolicy = (appId: string): void => {
  appNotificationPolicies.update(($map) => {
    if (!(appId in $map)) return $map;
    const next = { ...$map };
    delete next[appId];
    return next;
  });
};

/** Apps the player has muted on at least one channel — what the Settings summary counts. */
export const customisedNotificationApps = derived(appNotificationPolicies, ($map) =>
  Object.entries($map)
    .filter(([, policy]) => !policy.banner || !policy.sound || !policy.badge)
    .map(([appId]) => appId)
);

/**
 * How long a second call from the same number still counts as "they are trying to reach me".
 *
 * Three minutes: long enough that redialling after a missed ring breaks through, short enough
 * that it is not a standing exemption for anyone who called once today.
 */
export const REPEAT_CALL_WINDOW_MS = 3 * 60 * 1000;

const lastCallAt = new Map<string, number>();

/** Test seam, matching `__resetAppEvents` and friends. */
export const __resetCallHistory = (): void => lastCallAt.clear();

/**
 * Does this call break through Do Not Disturb and ring out loud?
 *
 * Two allowances, both from the ticket, and both about the same thing: DND must not be the
 * reason somebody missed a call that mattered. A favourited contact is an explicit standing
 * statement that this person gets through; a second call inside `REPEAT_CALL_WINDOW_MS` is the
 * same statement made by the caller instead.
 *
 * Records the call either way, so this must be called exactly once per incoming ring — the
 * second invocation for the same ring would see the timestamp the first one wrote and report a
 * repeat. `Shell.svelte`'s `callStatus` handler is that one site.
 */
export const callBreaksThrough = (number: string): boolean => {
  const now = Date.now();
  const previous = lastCallAt.get(number);
  lastCallAt.set(number, now);

  const favourited = get(contacts).some((contact) => contact.phone === number && contact.favorite);
  if (favourited) return true;

  return previous !== undefined && now - previous <= REPEAT_CALL_WINDOW_MS;
};

export interface NotificationContext {
  /** Defaults to `feedback` — see `NotificationSource`. */
  source?: NotificationSource;
  app?: string;
  /** For `source: 'call'` only: `callBreaksThrough` said this one rings anyway. */
  breakThrough?: boolean;
}

/**
 * The one question every notification path asks: may I do this?
 *
 * Three channels, and they are genuinely three features — "do not disturb" means the banner to
 * one person, the sound to another, and the badge to a third. What this phone means by each:
 *
 * **DND suppresses the banner and the sound. It does not touch the badge, the shade row, or the
 * stored notification.** That is the ticket's "suppress the interruption, never the record"
 * taken literally: a badge is not an interruption, it is what you see when you go looking, and
 * a DND that hid the count would leave a player with no way to tell they had missed anything.
 *
 * **A call's banner is never suppressed, by DND or by muting the phone app.** Not a courtesy —
 * a structural fact about this codebase. `toast.showCall` is not an announcement *about* an
 * incoming call, it is the only UI that can answer one: the Accept and Decline buttons live on
 * that toast and nowhere else. Suppressing it would not make the call quiet, it would make the
 * call unanswerable, and the shade row it left behind has no Accept button on it. So DND
 * silences the *ringtone* and leaves the banner — which is a fair reading of what a player
 * wants from DND anyway ("stop making noise at me", not "stop letting people reach me"), and
 * it is what makes the break-through rules above about sound rather than about visibility.
 *
 * A ringtone also ignores the global **Notification Sounds** switch, which reads "play alert
 * sound on incoming notification". Turning off notification sounds must not silence the phone
 * ringing; that is what DND and the device mute are for.
 */
export const notificationAllows = (
  channel: NotificationChannel,
  context: NotificationContext = {}
): boolean => {
  const source = context.source ?? 'feedback';
  if (source === 'system' || source === 'feedback') return true;

  const dnd = get(dndEnabled);

  if (source === 'call') {
    if (channel === 'banner') return true;
    if (channel === 'badge') return true;
    return !dnd || context.breakThrough === true;
  }

  const policy = policyForApp(context.app, get(appNotificationPolicies));

  switch (channel) {
    case 'banner':
      return get(toastsEnabled) && policy.banner && !dnd;
    case 'sound':
      return get(notificationSoundEnabled) && policy.sound && !dnd;
    case 'badge':
      // Badges survive DND on purpose — see the note above.
      return get(badgesEnabled) && policy.badge;
  }
};

/** `notificationAllows('badge', …)` for a bare app id, which is all the icon components have. */
export const badgeAllowedFor = (appId: string | undefined): boolean =>
  notificationAllows('badge', { source: 'app', app: appId });

/**
 * The badge question as a *store of a predicate*, for the launcher surfaces.
 *
 * `AppIcon` lives in `sdk/ui`, which may not import `shell/state` — an add-on bundle has no
 * shell to import, and `seam.test.ts` enforces it. So the decision is made on the shell side
 * and handed over as a plain boolean, which leaves four call sites (`Launcher`, `Dock`,
 * `FolderPopup`, `AppDrawer`) each needing the answer to re-derive when a switch moves.
 *
 * A derived store *containing a function* rather than four hand-written `$derived` blocks:
 * `$badgeAllowed(app.id)` is one reactive expression per site, it recomputes when either
 * input changes because the function identity changes with them, and it allocates no store
 * per icon the way a `derived()` factory called inside an `{#each}` would.
 */
export const badgeAllowed = derived(
  [badgesEnabled, appNotificationPolicies],
  ([$badgesEnabled, $policies]) =>
    (appId: string | undefined): boolean =>
      $badgesEnabled && policyForApp(appId, $policies).badge
);
