// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Readable } from 'svelte/store';
import { guarded } from './guard';

/**
 * Whether the player can see this app right now (MICA-294): a device is open, its screen is
 * showing apps — no lock screen or dead battery over it — and this app is the one in front.
 * Phone and tablet alike.
 *
 * `onAppForeground` answers a different question. It fires when the app *comes to the
 * front*, and putting the phone away does not send the app anywhere: it is still the current
 * app, so nothing arrives when the phone goes down, and an app kept mounted across the close
 * gets no second foreground when it comes back up. An app that polls — Places reads live
 * positions every few seconds — cannot tell from it that nobody is looking. This can.
 *
 * Use `onAppForeground` to load, and this to decide whether to *keep* doing something:
 *
 * ```ts
 * const visible = useAppVisible('places');
 * $effect(() => {
 *   if (!$visible) return;
 *   void refresh();
 *   return every(5000, () => void refresh());
 * });
 * ```
 *
 * The app names itself, as it does for `onAppForeground`, and can only ever ask about
 * itself: a sandboxed add-on's id is pinned by the shell, whatever it sends. Implicit, like
 * `onAppForeground`: an app knowing whether it is on screen discloses nothing about any
 * other. In an add-on it reads `false` until the shell's first answer arrives.
 */
export function useAppVisible(appId: string): Readable<boolean> {
  return guarded('useAppVisible', appId).facets.lifecycle(appId).visible;
}
