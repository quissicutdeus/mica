// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';

/**
 * Whether the phone frame is currently open (on screen), mirroring `Shell.svelte`'s own
 * `visible` rune.
 *
 * `Shell.svelte` is the real source of truth — it is a *component*, not a module, so
 * nothing outside it can import that rune directly. This store exists for the handful of
 * things that need to know open/closed anyway and have no other way to ask:
 * `toast.ts`'s closed-phone peek (MICA-141) is the one consumer today, kept in sync by a
 * one-line `$effect` in `Shell.svelte`.
 */
export const isPhoneOpen = writable<boolean>(false);
