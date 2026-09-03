// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, writable } from 'svelte/store';
import type { DeviceId } from '@gphone/shared/devices';

/**
 * Which device's frame is currently on screen, or `null` when none is — mirroring
 * `Shell.svelte`'s own `visible` rune and `state/device.ts`'s `activeDevice` together.
 *
 * `Shell.svelte` is the real source of truth — it is a *component*, not a module, so
 * nothing outside it can import that rune directly. This store exists for the handful of
 * things that need to know open/closed anyway and have no other way to ask, kept in sync
 * by a one-line `$effect` in `Shell.svelte`.
 *
 * It was a boolean, `isPhoneOpen`, until the tablet (MICA-259). The name below is kept
 * as a derived view so `toast.ts`'s closed-phone peek (MICA-141) and its tests read
 * exactly as before: the peek is for "no frame is up", and that is what `!== null` says —
 * a toast arriving while the *tablet* is open renders in its `ToastHost` like any other.
 */
export const openDevice = writable<DeviceId | null>(null);

export const isPhoneOpen = derived(openDevice, ($device) => $device !== null);
