// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get } from 'svelte/store';
import { usePersisted } from '../../../../sdk/host/usePersisted';
import { cellServiceEnabled, setCellServiceEnabled } from './signal';
import { bluetoothEnabled, setBluetoothEnabled } from './bluetooth';

/**
 * Airplane mode — a quick "kill the radios" switch, not a third independent toggle.
 * Enabling it locks network and bluetooth off; disabling it restores both to whatever
 * they were set to right before airplane mode was turned on.
 */
export const airplaneModeEnabled = usePersisted('settings', 'airplane_mode_enabled', false);

// Persisted, not plain variables — the phone can reload while airplane mode is still on
// (a full page reload keeps `airplaneModeEnabled` true via its own persistence), and an
// in-memory value would have already been lost by the time the player turns it back off.
const networkWasEnabledBeforeAirplane = usePersisted(
  'settings',
  'airplane_prev_network_enabled',
  true
);
const bluetoothWasEnabledBeforeAirplane = usePersisted(
  'settings',
  'airplane_prev_bluetooth_enabled',
  true
);

export const toggleAirplaneMode = (): void => {
  const enabling = !get(airplaneModeEnabled);
  airplaneModeEnabled.set(enabling);

  if (enabling) {
    networkWasEnabledBeforeAirplane.set(get(cellServiceEnabled));
    bluetoothWasEnabledBeforeAirplane.set(get(bluetoothEnabled));
    setCellServiceEnabled(false);
    setBluetoothEnabled(false);
  } else {
    setCellServiceEnabled(get(networkWasEnabledBeforeAirplane));
    setBluetoothEnabled(get(bluetoothWasEnabledBeforeAirplane));
  }
};
