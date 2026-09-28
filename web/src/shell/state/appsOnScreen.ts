// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived } from 'svelte/store';
import { DEVICES } from '@mica/shared/devices';
import { openDevice } from './phoneOpen';
import { isLocked } from './lockScreen';
import { isBatteryDead } from './charge';

/**
 * Whether the device's screen is showing apps right now (MICA-294) — the shell half of
 * `useAppVisible`, which adds "and it is this app".
 *
 * A frame has to be up (`openDevice`), and nothing may have taken the whole screen over. The
 * takeovers are the ones each frame draws *instead of* its `children`: the dead battery on
 * both, and the lock screen on a device whose chrome has one — the phone, not the tablet
 * (`DEVICES[id].chrome.lockScreen`; `TabletFrame.svelte` draws no lock screen until MICA-264).
 * This restates those two `{#if}`s in `PhoneFrame.svelte` and `TabletFrame.svelte`, and
 * `appsOnScreen.test.ts` pins the table so a change to one is a change to both.
 *
 * Not "is the app mounted". Closing is meant to unmount every app, but the frame's outro can
 * leave it mounted (the close-path note in `web/e2e/keybinds.spec.ts`), so an app that
 * treats "still mounted" as "still on screen" polls a closed phone for as long as the
 * player leaves it closed. This store is the answer that does not depend on that.
 */
export const appsOnScreen = derived(
  [openDevice, isLocked, isBatteryDead],
  ([$device, $locked, $dead]) =>
    $device !== null && !$dead && !($locked && DEVICES[$device].chrome.lockScreen)
);
