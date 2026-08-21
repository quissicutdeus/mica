import { writable, derived } from 'svelte/store';
import { isBrowser } from '../../lib/isBrowser';
import { usePersisted } from '../../sdk/host/usePersisted';

export interface TimeState {
  hours: number;
  minutes: number;
}

const getRealTime = (): TimeState => {
  const now = new Date();
  return {
    hours: now.getHours(),
    minutes: now.getMinutes()
  };
};

export const time = writable<TimeState>(getRealTime());
export const is24Hour = usePersisted<boolean>('settings', 'is24Hour', false, {
  sanitize: (value: unknown): boolean => value === true
});

// Live update time in browser dev mode (outside FiveM NUI)
if (isBrowser()) {
  setInterval(() => {
    const real = getRealTime();
    time.update((current) => {
      if (current.hours !== real.hours || current.minutes !== real.minutes) {
        return real;
      }
      return current;
    });
  }, 1000);
}

/**
 * Today's real calendar date — independent of `time`, which the NUI's own `setTime`
 * overrides with hours/minutes alone (a game clock, not a calendar). Shown in the status
 * bar only once the shade is fully open (`PhoneFrame.svelte`), so it never competes with
 * the compact clock-only reading the collapsed bar needs.
 */
const getRealDate = (): string =>
  new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

export const formattedDate = writable<string>(getRealDate());

if (isBrowser()) {
  setInterval(() => {
    const real = getRealDate();
    formattedDate.update((current) => (current !== real ? real : current));
  }, 1000);
}

export const formattedTime = derived([time, is24Hour], ([$time, $is24Hour]) => {
  const { hours, minutes } = $time;
  const paddedMinutes = minutes < 10 ? '0' + minutes : minutes;

  if ($is24Hour) {
    const paddedHours = hours < 10 ? '0' + hours : hours;
    return `${paddedHours}:${paddedMinutes}`;
  } else {
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${paddedMinutes} ${period}`;
  }
});
