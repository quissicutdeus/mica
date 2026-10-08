// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get } from 'svelte/store';
import type { DeviceId } from '@mica/shared/devices';
import { activeDevice } from './device';
import { openDevice } from './phoneOpen';
import { bootstrapStores, resetBootstrapState } from './bootstrap';
import { evaluateLockOnOpen, isLocked, noteLockScreenClosed } from './lockScreen';
import { hydrateSettingsOnCharacterLoad } from '../../host/facets/storage';
import { flushPendingWrites } from '../../host/settingsSync';
import { forgetPasscodeAnswer, refreshPasscodeStatus } from '../../services/passcode';

/**
 * A change of active device is a change of identity (MICA-264).
 *
 * A phone and a tablet hold separate notes, settings and passcode, and every request names
 * the device on screen (`nui/fetchNui.ts`) — but every cache in the shell holds one answer,
 * the last device's. So a switch is the same full rehydrate a phone swap already gets from
 * the `rehydrateShell` route (`shell/nuiMessages.ts`): the bootstrap's preloads again, and the
 * sweeping settings hydrate, against the new device.
 *
 * The lock is the part with an order to it. `evaluateLockOnOpen` reads `hasPasscode`
 * synchronously the moment a frame comes up, and the answer on hand is the old device's, so
 * the answer is forgotten first — which `evaluateLockOnOpen` reads as "lock" — and the lock is
 * evaluated again only once the new device's passcode and its auto-lock policy have both
 * answered. Without that the tablet opened unlocked on the phone's "no passcode".
 *
 * `previous` is the device being left. When a frame is still up across the switch (the
 * browser's swap, which never sets `visible` false) that device is noted closed here, since
 * `Shell.svelte`'s visibility effect never sees it go.
 */
export async function switchDeviceIdentity(device: DeviceId, previous: DeviceId): Promise<void> {
  const open = get(openDevice);
  if (open === previous) noteLockScreenClosed(previous);

  // Writes made on the device being left go out now, each stamped with it, before the new
  // device's rows are swept into the cache (`settingsSync.ts` says why a pending key matters).
  flushPendingWrites();

  forgetPasscodeAnswer();
  isLocked.set(false);
  // A frame already up — the swap — shows the new device at once, so it is evaluated now
  // (and locks, the answer being unknown) rather than showing its apps until the answer lands.
  if (open !== null) evaluateLockOnOpen();

  resetBootstrapState();
  // Only when a frame is up: otherwise the next open's own `bootstrapStores()` in
  // `Shell.svelte` runs it, reset, and a closed shell has no reason to preload anything yet.
  if (open !== null) void bootstrapStores(true);

  await Promise.allSettled([refreshPasscodeStatus(), hydrateSettingsOnCharacterLoad()]);

  // Superseded by a later switch, which is evaluating for itself.
  if (get(activeDevice) !== device) return;
  if (get(openDevice) === device) evaluateLockOnOpen();
}

/**
 * Follow `activeDevice` for the life of the page. `Shell.svelte` installs it once, as it does
 * the music broadcast; the device it starts on needs no switch, since the page-load reads in
 * `Shell.svelte`'s mounts were asked for it.
 */
export function installDeviceIdentity(): () => void {
  let current = get(activeDevice);
  return activeDevice.subscribe((next) => {
    if (next === current) return;
    const previous = current;
    current = next;
    void switchDeviceIdentity(next, previous);
  });
}
