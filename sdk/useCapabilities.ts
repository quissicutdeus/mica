// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get, type Readable } from 'svelte/store';
import type { AppCapability } from './manifest';
import { satisfiedCapabilities } from './host/seam/capabilities';

const NONE: readonly AppCapability[] = Object.freeze([]);

/**
 * What of `requires` this server lacks, in declaration order and without repeats. Empty
 * while the server has not answered: "unknown" is not "missing", and a catalog row that
 * said "needs money" for the beat before the reply would be telling the player something
 * untrue.
 */
const missingFrom = (
  satisfied: ReadonlySet<AppCapability> | null,
  requires: readonly AppCapability[] | undefined
): readonly AppCapability[] => {
  if (satisfied === null || !requires || requires.length === 0) return NONE;
  const missing = [...new Set(requires)].filter((c) => !satisfied.has(c));
  return missing.length === 0 ? NONE : Object.freeze(missing);
};

/** One reading of the server's capabilities. */
interface CapabilityAnswer {
  /** Whether the server has answered. Until it has, `missing` reports nothing. */
  known: boolean;
  /** The capabilities in `requires` this server cannot satisfy. Empty means satisfiable. */
  missing(requires: readonly AppCapability[] | undefined): readonly AppCapability[];
}

/**
 * Which of an app's `requires` capabilities this phone's server cannot satisfy — so a
 * screen listing apps that are not installed yet can explain one it would refuse, rather
 * than offer an install `registerAddOn` turns away (MICA-169).
 *
 * `useCapabilities().missing(entry.requires)` is a snapshot. The returned object is also a
 * store, so `$caps.missing(entry.requires)` re-renders when the server's answer lands or
 * changes (it is re-asked on a character switch). An empty result means satisfiable *or not
 * yet known*; `$caps.known` tells the two apart when that matters.
 *
 * **`core: true` only — `@mica/sdk/core`, not `@mica/sdk`.** The answer is not secret in
 * the sense a player's data is: it is two booleans about the server, and an add-on on a
 * server without money learns as much from its own `useBank()` calls failing. It is kept
 * off the public surface anyway, for two reasons:
 *
 * - **It is a one-way door with no asker.** Every export on `@mica/sdk` is a promise to
 *   add-ons nobody in this repo can see. The only reader is the phone's own catalog, and an
 *   add-on is never shown when its own `requires` is unsatisfiable — the launcher hides it
 *   and `registerAddOn` refuses it — so an add-on has no question for this to answer that
 *   its manifest does not already answer. Publishing it later is additive; unpublishing is a
 *   break.
 * - **It is a fingerprint of the server's framework.** Which of `ALL_CAPABILITIES` a server
 *   satisfies says which framework bridge it runs, and a sandboxed bundle phoning that home
 *   through its `networkHosts` gains nothing a player benefits from.
 *
 * So there is no host facet and no iframe twin: the store lives in `host/seam/`, the shell
 * writes it, and `vite.addon.config.ts` has no alias for `@mica/sdk/core`, so nothing here
 * can enter an add-on bundle. An add-on frame naming a `capabilities` facet over
 * `postMessage` is refused as an unknown facet (`useCapabilities.test.ts` pins both).
 *
 * It decides what the UI *says*, never what the server *allows* — see
 * `AppManifest.requires`. The server refuses every action it would have refused anyway.
 */
export function useCapabilities(): Readable<CapabilityAnswer> & CapabilityAnswer {
  const answer = derived(satisfiedCapabilities, ($satisfied): CapabilityAnswer => ({
    known: $satisfied !== null,
    missing: (requires) => missingFrom($satisfied, requires)
  }));
  return {
    subscribe: answer.subscribe,
    get known() {
      return get(satisfiedCapabilities) !== null;
    },
    missing: (requires) => missingFrom(get(satisfiedCapabilities), requires)
  };
}
