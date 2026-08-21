import { derived } from 'svelte/store';
import { usePersisted } from '../../sdk/host/usePersisted';

/**
 * Bluetooth state management and anti-doxxing privacy controls.
 *
 * Defaults to ON (true) and persists state across app launches and phone restarts.
 * When OFF, the device is invisible to proximity scans and blocks unsolicited contact
 * sharing or snooping attempts.
 */
export const bluetoothEnabled = usePersisted('settings', 'bluetooth_enabled', true);

export const toggleBluetooth = (): void => bluetoothEnabled.update((v) => !v);
export const setBluetoothEnabled = (enabled: boolean): void => bluetoothEnabled.set(enabled);

/**
 * Derived store indicating whether the device is visible/discoverable for Bluetooth proximity features.
 */
export const isBluetoothDiscoverable = derived(bluetoothEnabled, ($enabled) => $enabled);
