import { get } from 'svelte/store';
import { registerFacet } from '../../sdk/host/current';
import { registerClockPreference } from '../../sdk/host/seam/clockPreference';
import { time, is24Hour, formattedTime } from '../../shell/state/time';

/**
 * The phone's clock, and how it is displayed — read-only. Changing the 12/24-hour
 * preference is `useClockWrite` (MICA-127).
 *
 * Split out of `useSystemHardware`, which had grown to mean "anything the shell owns".
 * A 12-versus-24-hour preference is not hardware — it is a locale setting that happens
 * to live next to the clock, and an app asking for the time should not have to reach
 * through battery and signal to find it.
 */
export function clock() {
  return {
    /** The current time, updated by the shell. */
    time,
    /** Whether to render it in 24-hour form. Settings writes it through `useClockWrite`. */
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

registerFacet('clock', clock);

/**
 * `formatTime`'s default, installed rather than imported.
 *
 * MICA-172: `lib/sdk/formatters.ts` used to import `is24Hour` straight out of
 * `shell/state/time.ts`, which put that module's module-scope `usePersisted` call inside
 * the shared SDK chunk and killed boot before any facet had registered. It installs from
 * here for the same reason `storage.ts` installs the settings hydrator: this file is
 * reached only through `host/registerFacets.ts`, which only `src/main.ts` imports.
 */
registerClockPreference(() => get(is24Hour));
