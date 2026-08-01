import { time, is24Hour } from '../../shell/state/time';

/**
 * The phone's clock, and how it is displayed.
 *
 * Split out of `useSystemHardware`, which had grown to mean "anything the shell owns".
 * A 12-versus-24-hour preference is not hardware — it is a locale setting that happens
 * to live next to the clock, and an app asking for the time should not have to reach
 * through battery and signal to find it.
 */
export function useClock() {
  return {
    /** The current time, updated by the shell. */
    time,
    /** Whether to render it in 24-hour form. Writable: Settings toggles it. */
    is24Hour
  };
}
