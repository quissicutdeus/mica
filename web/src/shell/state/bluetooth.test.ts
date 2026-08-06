import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  bluetoothEnabled,
  toggleBluetooth,
  setBluetoothEnabled,
  isBluetoothDiscoverable
} from './bluetooth';

describe('Bluetooth Store', () => {
  beforeEach(() => {
    setBluetoothEnabled(true);
  });

  it('defaults Bluetooth to enabled (ON) for proximity discovery', () => {
    expect(get(bluetoothEnabled)).toBe(true);
    expect(get(isBluetoothDiscoverable)).toBe(true);
  });

  it('toggles Bluetooth state and updates discoverability', () => {
    toggleBluetooth();
    expect(get(bluetoothEnabled)).toBe(false);
    expect(get(isBluetoothDiscoverable)).toBe(false);

    toggleBluetooth();
    expect(get(bluetoothEnabled)).toBe(true);
    expect(get(isBluetoothDiscoverable)).toBe(true);
  });

  it('blocks discoverability when set to disabled (OFF)', () => {
    setBluetoothEnabled(false);
    expect(get(bluetoothEnabled)).toBe(false);
    expect(get(isBluetoothDiscoverable)).toBe(false);
  });
});
