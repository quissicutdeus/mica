// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { airplaneModeEnabled, toggleAirplaneMode } from './airplane';
import { cellServiceEnabled, setCellServiceEnabled } from './signal';
import { bluetoothEnabled, setBluetoothEnabled } from './bluetooth';
import { useStorage } from '../../sdk/host/useStorage';

describe('Airplane Mode Store', () => {
  beforeEach(() => {
    if (get(airplaneModeEnabled)) toggleAirplaneMode();
    setCellServiceEnabled(true);
    setBluetoothEnabled(true);
  });

  it('defaults Airplane Mode to disabled (OFF)', () => {
    expect(get(airplaneModeEnabled)).toBe(false);
  });

  it('forces network and bluetooth off when enabled', () => {
    toggleAirplaneMode();

    expect(get(airplaneModeEnabled)).toBe(true);
    expect(get(cellServiceEnabled)).toBe(false);
    expect(get(bluetoothEnabled)).toBe(false);
  });

  it('restores prior network and bluetooth state when disabled', () => {
    setBluetoothEnabled(false); // was already off before airplane mode
    toggleAirplaneMode(); // on: network off, bluetooth stays off
    toggleAirplaneMode(); // off: restore

    expect(get(airplaneModeEnabled)).toBe(false);
    expect(get(cellServiceEnabled)).toBe(true);
    expect(get(bluetoothEnabled)).toBe(false);
  });

  it('restores bluetooth to its prior enabled state, not just off', () => {
    toggleAirplaneMode(); // on: network off, bluetooth off (was on before)
    toggleAirplaneMode(); // off: restore

    expect(get(cellServiceEnabled)).toBe(true);
    expect(get(bluetoothEnabled)).toBe(true);
  });

  it('writes the prior network/bluetooth state to storage, so it survives a reload mid-flight', () => {
    setBluetoothEnabled(false); // prior state is: network on, bluetooth off
    toggleAirplaneMode(); // on

    const storage = useStorage('settings');
    expect(storage.getItem('airplane_prev_network_enabled', null)).toBe(true);
    expect(storage.getItem('airplane_prev_bluetooth_enabled', null)).toBe(false);
  });
});
