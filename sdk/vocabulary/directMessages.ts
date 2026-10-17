// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What `Facets['directMessages']` reads and writes. MICA-390 — see `./accounts.ts` for why
 * the SDK names its nouns here rather than borrowing them from the phone.
 *
 * Both are `@mica/shared/types`' own, re-exported rather than restated: the server answers
 * in exactly these shapes, and a second copy is a copy that drifts. `BlabberDm` and
 * `BlabberDmThread` are the same two types under Blabber's older names, and stay in
 * `shared/` only.
 */
export type { DirectMessage, DirectMessageThread } from '@mica/shared/types';
