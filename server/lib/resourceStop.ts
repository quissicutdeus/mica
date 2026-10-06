// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `onResourceStop` for code that releases what **another** resource owns (MICA-308 review).
 *
 * `onResourceStop` is an ordinary local event, so any server script can fire it:
 * `TriggerEvent('onResourceStop', 'victim')`. A handler that drops whatever `victim` registered
 * would then release it on the forger's word — a number, an add-on service id, an invoice
 * callback — and the forger could take the id over and receive every player's calls to it.
 *
 * The real event fires while the resource is going down, and `GetResourceState` says so: it is
 * `'stopping'` (or `'stopped'`, `'missing'`) by then, never `'started'`. A forged event naming a
 * running resource is ignored. `'starting'` is ignored too: a resource registers from its own
 * scripts while it is starting, and a forged stop in that window would release what it had just
 * registered.
 *
 * Handlers that react only to **micaOS itself** stopping (`Phone.ts`'s speaker release) do not
 * release anybody's ownership and do not go through here.
 */

/** Whether an `onResourceStop` naming `resource` is the real thing rather than a forged one. */
export const isGenuineStop = (resource: unknown): resource is string => {
  if (typeof resource !== 'string' || resource.length === 0) return false;
  // Absent outside FXServer (the SQL codegen, a test that does not stub it): nothing to ask, and
  // nothing there can forge an event either.
  if (typeof GetResourceState !== 'function') return true;
  const state = GetResourceState(resource);
  return state !== 'started' && state !== 'starting';
};

/**
 * Run `release(resource)` when a resource other code may have registered things for really
 * stops. A forged event is dropped silently: logging it would let the forger write the log.
 */
export const onResourceReleased = (release: (resource: string) => void): void => {
  on('onResourceStop', (resource: unknown) => {
    if (isGenuineStop(resource)) release(resource);
  });
};
