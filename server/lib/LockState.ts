// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { activePhoneIdOf } from '../services/Phones';

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
 * `IsPhoneLocked` from the last value either one set. Nothing survives here across a
 * restart, and a resource that needs the lock to survive one has to reapply it in its own
 * `onResourceStart` or `playerConnecting`, the same as it would for `SetPhoneEnabled`.
 *
 * Keyed by **phone** since MICA-283 — see `keyFor`.
 */
const locked = new Map<string, boolean>();

/**
 * What the lock is keyed on (MICA-283): the phone in the source's hand, so that switching
 * phones switches the lock with everything else. A burner picked up locked stays locked, in
 * whoever's hand it lands, and unlocking one phone unlocks nothing else. A source that has
 * not resolved a phone yet — a resource locking a player before their first device-owned
 * request — is keyed on the source itself, the pre-283 behaviour, and `playerDropped` clears
 * exactly those entries: a phone's own lock is meant to outlive a session.
 */
const keyFor = (source: number): string => activePhoneIdOf(source) ?? `source:${source}`;

/** For `IsPhoneLocked`. Defaults to unlocked for a phone, or a source, never heard from. */
export const isPhoneLocked = (source: number): boolean => locked.get(keyFor(source)) ?? false;

/** For `LockPhone`/`UnlockPhone`. Not exported as a net-reachable action — only `publicApi.ts` calls this. */
export const setPhoneLocked = (source: number, value: boolean): void => {
  locked.set(keyFor(source), value);
};

/** Test seam: the map is module state that would otherwise leak between cases. */
export const __resetLockState = (): void => {
  locked.clear();
};

on('playerDropped', () => {
  // FiveM reuses server ids, so a stale `true` left behind under a *source* key would greet
  // the next player to take this slot with a forced lock screen nobody told their session to
  // have. A phone-keyed lock is the phone's and stays.
  locked.delete(`source:${source}`);
});
