// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two statuses that replaced hard deletes (MICA-428). Nothing is ever deleted: every row is
 * kept for evidence, and these say who hid it, beside the player's own `deleted` and staff's
 * `moderated`.
 *
 * - **`expired`**: a retention window passed (`contentRetention.ts`, Dark Chat's sweep, the
 *   notifications prune). Declared by the tables a timer hides, and never restorable: a
 *   player's Recently Deleted reads `deleted` only.
 * - **`erased`**: the owner is gone or asked to be — the privacy delete, the character-deleted
 *   purge, the orphan sweep, `micaseed clear`. On every status table, appended by
 *   `defineService`, so every table a purge reaches can take it. Hidden from everyone, the
 *   owner included; kept for staff.
 */
export const EXPIRED = 'expired';
export const ERASED = 'erased';
