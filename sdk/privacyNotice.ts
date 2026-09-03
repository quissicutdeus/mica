// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MICA-70, item 1: tell players the truth, in the app.
 *
 * This ticket rejected end-to-end encryption on architectural grounds — the server ships
 * the client, so there is no independent copy of the client an operator cannot alter, which
 * is what E2EE actually depends on. What is left is honest disclosure: messages, DMs and
 * mail are stored in this server's own database and its administrators can read them. That
 * is inherent to how the phone works, not a bug, and no per-app privacy setting changes it.
 *
 * The closing sentence is item 3's player-facing half: Cody's audit logging (branch
 * `MICA-70`) already logs an admin's read of reported content, and item 3 says in so many
 * words to "make the log something a player can be told exists" — a log nobody is ever told
 * about does not do that. This is that telling.
 *
 * One string, read by the first-run notice (`shell/PrivacyNotice.svelte`) and the permanent
 * copy in Settings > About, so the two can never say something different from each other.
 *
 * Lives here, state-free, rather than in `shell/state/privacyNotice.ts` (which owns the
 * "has this been dismissed" flag) — that file imports `usePersisted`, and `sdk/addon.ts`
 * bundles standalone into a sandboxed add-on with no shell to import at all
 * (`sdk/seam.test.ts`). Mirrors `sdk/version.ts`'s own reasoning for `GOS_BUILD_INFO`.
 */
export const PRIVACY_NOTICE_TEXT =
  'Messages, direct messages, and mail sent through this phone are stored in this server’s database and can be read by its administrators. That’s inherent to how the phone works — not a bug — and no setting in this app changes it. When an admin reviews a report, that access is logged.';
