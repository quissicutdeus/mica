import { writable, derived } from 'svelte/store';
import { isBrowser } from '../../lib/isBrowser';

// Cellular signal level between 0 and 4 bars
export const signalLevel = writable<number>(4);

// Clamped signal level guaranteed to be between 0 and 4 integer
export const clampedSignalLevel = derived(signalLevel, ($level) => {
  return Math.max(0, Math.min(4, Math.round($level)));
});

export const setSignal = (level: number) => {
  const clamped = Math.max(0, Math.min(4, Math.round(level)));
  signalLevel.set(clamped);
};

if (isBrowser()) {
  (window as any).setSignalLevel = (level: number) => setSignal(level);
}
