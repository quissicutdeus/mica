// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { ControlCenterToggle, Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['controlCenter']>>;

/**
 * The iframe twin of the `controlCenter` facet (MICA-247).
 *
 * `onToggle` crosses as a callback ref — `encodeArgs` reaches one level into the toggle
 * object — so a tap in the shell posts a `callback` message back into this frame and runs
 * the add-on's own handler here. `lease` is a pushed store like any other; subscribing to it
 * is what makes the shell hold a subscription for this frame, and the frame's teardown
 * dropping that subscription is what takes its switches down.
 *
 * The three calls return promises the contract types as `void`; `useControlCenter` reports a
 * refused one rather than leaving it unhandled.
 */
export function controlCenter(appId: string): Twin {
  const factoryArgs = [appId];
  return {
    lease: store('controlCenter', factoryArgs, 'lease', false),
    registerToggle: (toggle: ControlCenterToggle) =>
      fn<(t: ControlCenterToggle) => Promise<void>>(
        'controlCenter',
        factoryArgs,
        'registerToggle'
      )(toggle),
    unregisterToggle: (id: string) =>
      fn<(i: string) => Promise<void>>('controlCenter', factoryArgs, 'unregisterToggle')(id),
    setToggleActive: (id: string, active: boolean) =>
      fn<(i: string, a: boolean) => Promise<void>>(
        'controlCenter',
        factoryArgs,
        'setToggleActive'
      )(id, active)
  };
}

registerFacet('controlCenter', controlCenter);
