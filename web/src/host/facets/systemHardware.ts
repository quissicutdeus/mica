// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readable } from 'svelte/store';
import { registerFacet } from '../../../../sdk/host/current';
import { charge } from '../../shell/state/charge';
import { signalLevel, cellServiceEnabled } from '../../shell/state/signal';
import { bluetoothEnabled, isBluetoothDiscoverable } from '../../shell/state/bluetooth';
import {
  soundVolume,
  soundMuted,
  volumeStep,
  VOLUME_STEP_CHOICES,
  ringMode,
  RING_MODE_CHOICES,
  ringtone,
  RINGTONE_OPTIONS
} from '../../shell/state/audio';

/**
 * The phone's hardware: battery, cellular signal, cell service, bluetooth, volume controls,
 * and the ringer switch beside them — read-only. Changing any of it is `useSystemHardwareWrite`
 * (MICA-127).
 */
export function systemHardware() {
  return {
    charge,
    signalLevel,
    cellServiceEnabled,
    bluetoothEnabled,
    isBluetoothDiscoverable,
    soundVolume,
    soundMuted,
    /** How far one physical volume-button press moves the volume, in whole percent. */
    volumeStep,
    volumeStepChoices: VOLUME_STEP_CHOICES,
    /** The ringer switch: `'normal' | 'vibrate' | 'silent'`. MICA-62. */
    ringMode,
    /**
     * The choice lists are `readable` wrappers rather than the bare arrays, and that is a
     * transport decision, not a second source of truth — `shell/state/audio.ts` still owns
     * the one list. A plain value on a facet has to be hand-carried through
     * `AddOnConstants` (as `volumeStepChoices` is, because the first paint needs it
     * synchronously); a store rides the generic subscribe path an iframe twin already has.
     * Nothing renders a ringer picker before hydration, so the store is the cheaper half
     * of that trade.
     */
    ringModeChoices: readable(RING_MODE_CHOICES),
    ringtone,
    ringtoneChoices: readable(RINGTONE_OPTIONS)
  };
}

registerFacet('systemHardware', systemHardware);
