import { get } from 'svelte/store';
import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { registerClockPreference } from '../../seam/clockPreference';
import { is24Hour as frameIs24Hour } from '../shims/time';
import { store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['clock']>>;

export function clock(): Twin {
  return {
    time: store('clock', [], 'time', { hours: 0, minutes: 0 }),
    is24Hour: store('clock', [], 'is24Hour', false),
    formattedTime: store('clock', [], 'formattedTime', '')
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('clock', clock as unknown as Facets['clock']);

/**
 * `formatTime`'s default inside a sandboxed frame.
 *
 * MICA-172 moved this off a direct import of `shell/state/time.ts` and onto a seam, so
 * each side installs its own. The frame's answer is the shim's `is24Hour` rather than the
 * `store(...)` above: `formatTime` reads it **synchronously** during first paint, and a
 * remote store would hand back its seed until the subscribe reply landed — formatting every
 * early call in the wrong clock. That is the same reasoning `shims/time.ts` already gives
 * for not making this member a `remoteStore`.
 *
 * Reading it lazily inside the getter matters: the shim's `readable` calls `constants()` in
 * its start function, which is only populated once the hydrate message has arrived. By the
 * time anything formats a time, boot has finished.
 */
registerClockPreference(() => get(frameIs24Hour));
