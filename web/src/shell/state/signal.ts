import { writable, derived } from 'svelte/store';
import { isBrowser } from '../../lib/isBrowser';
import { usePersisted } from '../../sdk/host/usePersisted';

/**
 * Cellular network service state. Defaults to ON (true) and persists across reloads.
 * When OFF, cell service is disabled and clamped signal level is forced to 0 bars.
 */
export const cellServiceEnabled = usePersisted('settings', 'cell_service_enabled', true);

export const toggleCellService = (): void => cellServiceEnabled.update((v) => !v);
export const setCellServiceEnabled = (enabled: boolean): void => cellServiceEnabled.set(enabled);

// Cellular signal level between 0 and 4 bars
export const signalLevel = writable<number>(4);

// Clamped signal level guaranteed to be between 0 and 4 integer, or 0 when cell service is disabled
export const clampedSignalLevel = derived(
  [signalLevel, cellServiceEnabled],
  ([$level, $cellEnabled]) => {
    if (!$cellEnabled) return 0;
    return Math.max(0, Math.min(4, Math.round($level)));
  }
);

export const setSignal = (level: number): void => {
  const clamped = Math.max(0, Math.min(4, Math.round(level)));
  signalLevel.set(clamped);
};

if (isBrowser()) {
  window.setSignalLevel = (level: number) => setSignal(level);
}
