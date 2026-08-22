import { readable } from 'svelte/store';
import { remoteStore } from '../remote';
import { constants } from '../constants';

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
 * `time` and `formattedTime` are `remoteStore`s against the `clock` facet, the same members
 * `iframe/facets/clock.ts` already exposes on `useClock()` — that same live state, not a
 * second copy of it. No timer of its own: the shell ticks the real clock and pushes it
 * down; these only subscribe.
 */
export const time = remoteStore('clock', [], 'time', { hours: 0, minutes: 0 });

/**
 * `is24Hour` is the exception, and deliberately not a `remoteStore`.
 *
 * Its one real consumer is `formatTime`'s default, which reads the value **synchronously**
 * — `get(is24Hour)` during the frame's first paint. A `remoteStore` cannot answer that: it
 * hands back its seed and only later, when the subscribe reply lands, holds the real value,
 * so every `formatTime()` call before that silently formatted in the wrong clock. It also
 * required the `clock` permission, which nothing calling a formatter has any reason to
 * declare, so for most add-ons the subscribe was refused and the seed was *all* it ever
 * held.
 *
 * So the shell states it up front instead: `constants.clock.is24Hour`, filled in
 * `IframeHostServer`'s `constantsFor()` and set before the app mounts. A `readable` with no
 * start function, because it genuinely cannot change here — toggling the 24-hour setting
 * mid-session leaves an already-booted frame on the old form until it is reopened. That is
 * a preference nobody flips while an add-on is on screen, and a push topic for it is not
 * worth carrying today.
 *
 * Read inside the start function rather than as the seed: this module is evaluated as part
 * of the add-on's own module graph, which the bundle's entry imports *before* it calls
 * `bootAddOn` — a seed would call `constants()` before the hydrate reply set them and throw
 * on import. By the time anything subscribes, boot has finished.
 */
export const is24Hour = readable(false, (set) => {
  set(constants().clock.is24Hour);
});

export const formattedTime = remoteStore('clock', [], 'formattedTime', '');
