// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { onDestroy } from 'svelte';
import { guarded } from './guard';
import type { ControlCenterToggle } from './facets';

export type { ControlCenterToggle } from './facets';

/** What `useControlCenter` hands back. */
export interface ControlCenter {
  /** Put a switch in the control center; the returned function takes it down again. */
  registerToggle(toggle: ControlCenterToggle): () => void;
  /** Report a switch's state after the app acted on a tap, or on a change of its own. */
  setToggleActive(id: string, active: boolean): void;
}

/** Say a refused call out loud, whichever side of the seam refused it. */
function reported(appId: string, what: string, run: () => unknown): void {
  const warn = (error: unknown) =>
    console.error(`[micaOS] '${appId}' control center ${what} failed`, error);
  let result: unknown;
  try {
    result = run();
  } catch (error) {
    warn(error);
    throw error;
  }
  // A sandboxed add-on's call is a promise; in-process it is `undefined`.
  if (result instanceof Promise) result.catch(warn);
}

/**
 * Contribute this app's own switches to the control center (MICA-247). Requires the
 * `control-center` permission.
 *
 * ```ts
 * const cc = useControlCenter('radio');
 * cc.registerToggle({
 *   id: 'scanner',
 *   label: 'Scanner',
 *   icon: 'MicrophoneIcon',
 *   active: get(scanning),
 *   onToggle: () => {
 *     scanning.update((on) => !on);
 *     cc.setToggleActive('scanner', get(scanning));
 *   }
 * });
 * ```
 *
 * **The shell draws the switch; the app owns what it means.** A tap calls `onToggle` and
 * changes nothing on its own — the switch shows whatever the app last reported, so an app
 * that refuses a tap simply does not call `setToggleActive`.
 *
 * What the shell holds a switch to, checked on the phone's side of the seam (a sandboxed
 * add-on's arguments are whatever its script sent):
 *
 * - `id` is 1-32 letters, digits, `-` or `_`, unique within this app. Registering an id
 *   again replaces that switch.
 * - `label` is 1-32 characters after trimming.
 * - `icon` is the export name of an icon in `@mica/sdk`, such as `'MoonIcon'`.
 * - An app holds at most **3** switches at once; a fourth is refused, not rotated in.
 *
 * `appId` is this app's own id. For a `core: false` add-on the shell replaces it with the
 * frame's own, so a frame cannot put a switch up under another app's name or reach another
 * app's switches.
 *
 * **Switches live as long as the component that registered them**, like `useSearchProvider`:
 * unmount takes them down, and an add-on's frame going away takes down every switch it
 * holds whether or not its code got to run first. Apps are resident, so a switch registered
 * from an app's root component stays up for the session — but only once the app has been
 * opened; declare a `preload` if a switch must exist before that.
 *
 * A refused registration throws in-process and is logged from a sandboxed add-on, where the
 * shell answers after this function has returned.
 */
export function useControlCenter(appId: string): ControlCenter {
  const facet = guarded('useControlCenter', appId).facets.controlCenter(appId);
  const mine = new Set<string>();
  // Held before the first registration: the shell refuses a switch nobody holds a lease on.
  const releaseLease = facet.lease.subscribe(() => {});

  const unregister = (id: string) => {
    if (!mine.delete(id)) return;
    reported(appId, `unregister '${id}'`, () => facet.unregisterToggle(id));
  };

  try {
    onDestroy(() => {
      for (const id of Array.from(mine)) unregister(id); // a snapshot: unregister edits `mine`
      releaseLease();
    });
  } catch {
    // Called outside a component lifecycle; each returned function is the caller's to hold.
  }

  return {
    registerToggle(toggle) {
      reported(appId, `register '${String(toggle?.id)}'`, () => facet.registerToggle(toggle));
      mine.add(toggle.id);
      return () => unregister(toggle.id);
    },
    setToggleActive(id, active) {
      reported(appId, `update '${id}'`, () => facet.setToggleActive(id, active));
    }
  };
}
