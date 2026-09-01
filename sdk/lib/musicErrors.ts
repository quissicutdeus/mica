// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Why a track will not play, and what to call that in front of a person. MICA-111.
 *
 * Pure, and in `lib/` rather than beside the player in `shell/state/music.ts`, for the
 * same reason `shared/youtube.ts` holds the id parsing: an add-on runs in a sandboxed
 * iframe and bundles what it imports, so anything it needs synchronously — and a label on
 * a row is needed synchronously — has to be reachable without the shell. `useMusic`'s
 * iframe twin imports `describeMusicError` from here directly, exactly as it does
 * `canPlay` and `thumbnailUrlFor`.
 *
 * The wording living in one module is the other half, and it is the exception to this
 * repo's usual "wording belongs to the component" rule. The Music app, the shade's
 * now-playing row and whatever phase 4 adds are all describing the *same* refusal by the
 * same player, and three screens inventing three phrases for code 150 is how a person
 * concludes the phone has three different bugs. Each screen still decides whether to show
 * it, and where.
 */

/**
 * The three kinds the player's own codes actually distinguish. No finer taxonomy than they
 * support — inventing one would be putting words in the player's mouth about a failure it
 * described in a number.
 *
 * - `embed-blocked` — the uploader disabled playback outside YouTube (101, 150). This is
 *   the common one, and it covers a large fraction of the actual music on YouTube.
 * - `unavailable` — there is no such video to play: removed, private, or never there (100).
 * - `unplayable` — rejected for a reason the player did not narrow further (2, 5, and
 *   anything new).
 */
export type MusicErrorReason = 'embed-blocked' | 'unavailable' | 'unplayable';

export interface MusicError {
  reason: MusicErrorReason;
  /**
   * The player's own code, kept rather than discarded once mapped. The in-game procedure
   * in `docs/testing-music-in-cef.md` is the reason: "it did not play" and "it reported
   * 150" are different bug reports, and only one of them can be acted on.
   */
  code: number;
}

/**
 * The IFrame API's error codes, mapped.
 *
 * `5` sits with `unplayable` rather than `unavailable` on purpose: it says the HTML5
 * player cannot play the content, which is not the same claim as "it is gone". Anything
 * not listed maps to `unplayable` in `reasonForCode`, which is the honest answer to a code
 * nobody has seen — something is wrong with this video and the player did not say what.
 */
const ERROR_REASONS: Readonly<Record<number, MusicErrorReason>> = {
  2: 'unplayable',
  5: 'unplayable',
  100: 'unavailable',
  101: 'embed-blocked',
  150: 'embed-blocked'
};

export const reasonForCode = (code: number): MusicErrorReason =>
  ERROR_REASONS[code] ?? 'unplayable';

/** What to tell a person about a failure, in one phrase that fits a row and a card alike. */
export function describeMusicError(reason: MusicErrorReason): string {
  switch (reason) {
    case 'embed-blocked':
      return "Can't be played outside YouTube";
    case 'unavailable':
      return 'Unavailable — removed or private';
    default:
      return "Can't be played";
  }
}
