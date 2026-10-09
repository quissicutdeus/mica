// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DeviceId } from '@mica/shared/devices';
import { activeDeviceIdOf } from '../services/Devices';

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
 * Keyed by **device** since MICA-283 for the phone and MICA-264 for the tablet — see `keyFor`.
 */
const locked = new Map<string, boolean>();

/**
 * What the lock is keyed on (MICA-283): the device in the source's hand, so that switching
 * devices switches the lock with everything else. A burner picked up locked stays locked, in
 * whoever's hand it lands, and unlocking one device unlocks nothing else. A source that has
 * not resolved a device of that kind yet — a resource locking a player before their first
 * device-owned request — is keyed on the source itself, the pre-283 behaviour, and
 * `playerDropped` clears exactly those entries: a device's own lock is meant to outlive a
 * session.
 *
 * **The tablet follows its own id** since MICA-264 (`activeDeviceIdOf`), as the phone follows
 * its own: a tablet's id is a different row from any phone's, so its lock can never land on
 * the phone. Before it resolves one, its source key carries the device, so it is a different
 * key from the phone's pre-resolution one.
 */
const keyFor = (source: number, device: DeviceId): string =>
  activeDeviceIdOf(source, device) ??
  (device === 'phone' ? `source:${source}` : `source:${source}:${device}`);

/** Whether a device is locked. Defaults to unlocked for one, or a source, never heard from. */
export const isDeviceLocked = (source: number, device: DeviceId): boolean =>
  locked.get(keyFor(source, device)) ?? false;

/** For `LockPhone`/`UnlockPhone`. Not exported as a net-reachable action — only `publicApi.ts` calls this. */
export const setDeviceLocked = (source: number, device: DeviceId, value: boolean): void => {
  locked.set(keyFor(source, device), value);
};

/** Test seam: the map is module state that would otherwise leak between cases. */
export const __resetLockState = (): void => {
  locked.clear();
};

on('playerDropped', () => {
  // FiveM reuses server ids, so a stale `true` left behind under a *source* key would greet
  // the next player to take this slot with a forced lock screen nobody told their session to
  // have. A phone-keyed lock is the phone's and stays.
  // Every source-keyed entry goes: the phone's pre-resolution one and each tablet's.
  const prefix = `source:${source}`;
  for (const key of locked.keys()) {
    if (key === prefix || key.startsWith(`${prefix}:`)) locked.delete(key);
  }
});
