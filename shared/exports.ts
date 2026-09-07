// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The shape every micaOS export answers with, on both sides (MICA-224).
 *
 * A bare boolean cannot tell a caller "the player is offline" from "micaOS has not started",
 * so every export -- server or client -- returns a discriminated outcome instead, and none of
 * them throws across the resource boundary. The server's `lib/exports.ts` and the client's
 * `lib/publicApi.ts` both build on this so a script that reads one reads the other.
 */
export type ExportFailure =
  /** No player with that source, or no character loaded on it. */
  | 'unknown_player'
  /** The player is not on the server. Their data is still safe to write by citizenid. */
  | 'offline'
  /** micaOS has not finished starting. Retry, or wait for `onResourceStart`. */
  | 'not_ready'
  /** The arguments do not describe anything micaOS can act on. */
  | 'invalid_args'
  /** micaOS raised where it should not have. Reported rather than propagated. */
  | 'internal_error'
  /** Another resource already holds that number. */
  | 'already_registered'
  /** That number belongs to a different resource. */
  | 'not_owner'
  /** A character already holds that number, and a player always wins. */
  | 'number_in_use'
  /** The calling resource has exceeded an export's per-minute allowance (MICA-223). */
  | 'rate_limited'
  /**
   * The device will not open for this player right now (MICA-224): confiscated by
   * `SetPhoneEnabled(false)`, switched off by the server, or gated on an item they do not
   * hold. Closing it is always allowed; opening it is what this refuses.
   */
  | 'disabled';

export type ExportOutcome<T = undefined> =
  | ({ ok: true } & (T extends undefined ? { value?: undefined } : { value: T }))
  | { ok: false; reason: ExportFailure; message: string };

export const ok = <T = undefined>(value?: T): ExportOutcome<T> =>
  ({ ok: true, value }) as ExportOutcome<T>;

export const fail = <T = undefined>(reason: ExportFailure, message: string): ExportOutcome<T> => ({
  ok: false,
  reason,
  message
});
