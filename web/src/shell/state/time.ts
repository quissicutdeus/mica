import { writable, derived } from 'svelte/store';
import { isBrowser } from '../../lib/isBrowser';

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
export const is24Hour = writable<boolean>(false);

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
