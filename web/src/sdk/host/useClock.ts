import { time, is24Hour, formattedTime } from '../../shell/state/time';
import { assertCapability } from '../capability';

/**
 * The phone's clock, and how it is displayed.
 *
 * Split out of `useSystemHardware`, which had grown to mean "anything the shell owns".
 * A 12-versus-24-hour preference is not hardware — it is a locale setting that happens
 * to live next to the clock, and an app asking for the time should not have to reach
 * through battery and signal to find it.
 */
export function useClock() {
  assertCapability('clock', 'useClock');
  return {
    /** The current time, updated by the shell. */
    time,
    /** Whether to render it in 24-hour form. Writable: Settings toggles it. */
    is24Hour,
    /**
     * The time already rendered in the player's chosen form.
     *
     * Exposed so nothing re-implements the 12/24 branch. The status bar and the Display
     * preview both show a clock, and two formatters would be one preference with two
     * answers.
     */
    formattedTime
  };
}
