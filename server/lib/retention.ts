// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How long a soft-deleted row stays restorable (MICA-75).
 *
 * One shared convar across Contacts, Notes and Media rather than one per app: the three
 * are the same shape of "recently deleted" list a player would expect to behave the same
 * way everywhere in the phone, the way a single OS-level trash folder does, and a
 * server owner tuning "how long is deleted stuff undoable" almost certainly wants one
 * answer for all of them rather than three knobs that can drift apart by accident. An app
 * with a genuinely different need is free to declare its own convar instead — nothing
 * about `Repository.restore`'s `windowDays` parameter requires this one.
 *
 * Read per call rather than cached, matching `mica_notification_retention`'s own
 * `getRetentionDays` in `Notifications.ts` and every other operator-facing knob in this
 * codebase (`Hodlr.ts`'s `tradeMax`/`spreadPct`): a server owner changing it with `set`
 * from the console should not need a restart.
 *
 * This is a **restorability** window, not a retention one, despite the convar's shape
 * matching `mica_notification_retention`. Past it, `restore` simply matches no row —
 * the row itself is never hard-deleted by anything in this codebase, on purpose: the
 * moderation system depends on a soft-deleted row surviving forever, and this ticket was
 * explicitly asked not to add a hard-delete-after-window path.
 */
const RESTORE_WINDOW_CONVAR = 'mica_restore_window_days';
const DEFAULT_RESTORE_WINDOW_DAYS = 30;

export const restoreWindowDays = (): number => {
  const raw = Number.parseInt(
    GetConvar(RESTORE_WINDOW_CONVAR, String(DEFAULT_RESTORE_WINDOW_DAYS)),
    10
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RESTORE_WINDOW_DAYS;
};
