// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived } from 'svelte/store';
import { ALL_CAPABILITIES, type AppCapability } from '@mica/sdk';
import { satisfiedCapabilities } from '../../../sdk/host/seam/capabilities';
import { capabilities, capabilitiesKnown } from '../services/capabilities';

/**
 * Mirrors the shell's capability answer into the SDK seam `useCapabilities` reads
 * (MICA-169).
 *
 * The shell's store stays the authority — the launcher, the drawer and the install gate
 * read it directly, and this copies it, it never writes back. `null` until
 * `capabilitiesKnown`, so the boot-time assumption (all denied in game) is never reported
 * to an app as "this server lacks money"; see `sdk/host/seam/capabilities.ts`.
 *
 * Imported for its effect by `registerFacets.ts`, the one module both shell entry points
 * already load, so an app reading `useCapabilities()` sees the same answer the launcher
 * does in game and in every unit test that stands in for the shell. It is not a facet —
 * there is no iframe twin, on purpose — so it sits beside `facets/`, not in it, and the
 * seam test's boot-set check (which compares `./facets/*` imports) does not count it.
 */
const mirrored = derived([capabilities, capabilitiesKnown], ([$capabilities, $known]) =>
  $known
    ? new Set<AppCapability>(ALL_CAPABILITIES.filter((name) => $capabilities[name] === true))
    : null
);

mirrored.subscribe((value) => satisfiedCapabilities.set(value));
