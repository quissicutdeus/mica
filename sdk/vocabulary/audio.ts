// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The sound vocabulary `Facets['sound']`, `Facets['systemHardware']` and their write twins
 * are stated in. MICA-172 — see `./accounts.ts`.
 *
 * None of these is on the published surface, and that is deliberate: `RingtoneOption` is
 * narrow precisely so an add-on cannot depend on how a tone is *made* (`wave`, `level`, the
 * step table), which `shell/state/audio.ts` expects to change whenever a ringtone is retuned.
 * Moving the type into the package does not publish it.
 */

export type SoundEffect = 'click' | 'pop' | 'camera' | 'notification' | 'ringtone';

/**
 * **Silent suppresses audio and nothing else.** The incoming-call banner still appears
 * with its Accept button, and the in-game phone animation still plays: a call you cannot
 * hear is a quiet call, but a call you cannot *see* is an unanswerable one — the same
 * reasoning `notificationPolicy.ts` gives for why Do Not Disturb never withholds a call
 * banner.
 */
export type RingMode = 'normal' | 'vibrate' | 'silent';

export interface RingModeChoice {
  readonly id: RingMode;
  readonly label: string;
  /** Shown under the label in Settings > Sound. Says what the mode actually does. */
  readonly description: string;
}

/**
 * A ringtone: one of the five built-in ids (`'classic' | 'chime' | 'beacon' | 'pulse' |
 * 'ascent'`) or `'owner:<stem>'`, a sound the server owner shipped (MICA-256). A stem is 1-48
 * of `A-Z a-z 0-9 . _ -`, not starting with a dot, so an id is at most 54 characters; both
 * halves are case-sensitive. The one statement of that grammar is `isRingtoneValue` in
 * `shared/ownerConfig.ts`, which the shell and the server both check against.
 *
 * `string` rather than that union because the owner's half is only known at runtime — it is
 * whatever files the owner put in `branding/sounds/` — so no type written here could list
 * it. The shell checks an id against what it actually has, and one it does not recognise is
 * refused rather than stored; read the live list from `ringtoneChoices` rather than
 * matching on names.
 */
export type RingtoneId = string;

/**
 * A notification tone: `'default'` (the built-in chirp) or `'owner:<stem>'` (MICA-256).
 * `string` for the same reason as `RingtoneId`; the live list is `notificationToneChoices`.
 */
export type NotificationToneId = string;

/** What a chooser needs, and nothing behind it. Used for both tone lists. */
export interface RingtoneOption {
  readonly id: RingtoneId;
  /** Shown as-is: a built-in's translated name, or the owner's own name for a sound. */
  readonly label: string;
}
