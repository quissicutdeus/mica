import { remoteStore } from '../remote';

/**
 * The add-on-build alias target for `shell/state/time.ts` — not a facet twin (there is no
 * `clock` member for a wall-clock ticker; the frame has no reason to run its own
 * `setInterval`), just the subset of `shell/state/time.ts`'s exports something reachable
 * from an add-on's module graph actually imports: `src/lib/formatters.ts` (re-exported
 * from `@gphone/sdk`'s `utils.ts`, so reachable from every add-on) reads `is24Hour` for
 * `formatTime`'s default, and the inProcess `clock` facet's own file — unreachable from an
 * add-on today, but resolved the same way if anything ever imports it that way — reads
 * `time`/`is24Hour`/`formattedTime`.
 *
 * Each is a `remoteStore` against the `clock` facet, the same members
 * `iframe/facets/clock.ts` already exposes on `useClock()` — this is that same live state,
 * not a second copy of it, so a formatter using `is24Hour` here and an app reading
 * `useClock().is24Hour` never disagree. No timer of its own: the shell ticks the real
 * clock and pushes it down; this only subscribes.
 */
export const time = remoteStore('clock', [], 'time', { hours: 0, minutes: 0 });
export const is24Hour = remoteStore('clock', [], 'is24Hour', false);
export const formattedTime = remoteStore('clock', [], 'formattedTime', '');
