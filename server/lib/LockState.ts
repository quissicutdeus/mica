// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Whether another resource last told micaOS to lock a player's phone (MICA-60).
 *
 * Deliberately not tied to the passcode lock screen at all: `web/src/shell/state/
 * lockScreen.ts`'s `isLocked` is entirely client-local, computed from whether a passcode
 * is set and the player's auto-lock policy, and nothing server-side gates on it (the
 * ticket's own item 4 — this is a display state, not a security boundary). This map is a
 * *different* lock, the `SetPhoneEnabled`-shaped one: an external resource (a jail script,
 * an item) forcing the lock screen up regardless of whether the player has a passcode at
 * all, the same way `SetPhoneEnabled` forces the phone closed regardless of what the
 * player was doing with it.
 *
 * In-memory rather than persisted, matching `PhoneOpenState.ts`: nothing here is fed by a
 * client push (there is no client listener for this yet — Kix's branch does not know this
 * export exists), so it is set only by `LockPhone`/`UnlockPhone` themselves and answers
 * `IsPhoneLocked` from the last value either one set. A player who reconnects gets a fresh
 * `false`, which is the honest answer: nothing survives here across a restart, and a
 * resource that needs the lock to survive one has to reapply it in its own `onResourceStart`
 * or `playerConnecting`, the same as it would for `SetPhoneEnabled`.
 */
const locked = new Map<number, boolean>();

/** For `IsPhoneLocked`. Defaults to unlocked for a source never heard from. */
export const isPhoneLocked = (source: number): boolean => locked.get(source) ?? false;

/** For `LockPhone`/`UnlockPhone`. Not exported as a net-reachable action — only `publicApi.ts` calls this. */
export const setPhoneLocked = (source: number, value: boolean): void => {
  locked.set(source, value);
};

on('playerDropped', () => {
  // FiveM reuses server ids, so a stale `true` left behind would greet the next player to
  // take this slot with a forced lock screen nobody told their session to have.
  locked.delete(source);
});
