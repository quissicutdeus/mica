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

export type RingtoneId = 'classic' | 'chime' | 'beacon' | 'pulse' | 'ascent';

/** What a chooser needs, and nothing behind it. */
export interface RingtoneOption {
  readonly id: RingtoneId;
  readonly label: string;
}
