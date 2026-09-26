// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import type { AppCapability } from '../../manifest';

/**
 * The server capabilities this phone's server satisfies, or `null` until it has answered.
 *
 * MICA-169. The shell's own answer lives in `web/src/services/capabilities.ts`, which the
 * launcher, the drawer and the install gate read directly. An app cannot import that
 * (AGENTS.md §2.7), so `web/src/host/capabilitiesSync.ts` mirrors it into this store, on
 * the side of the boundary that publishes it — the same arrangement `captureZoom.ts` has,
 * with the SDK owning the store and `web/` writing into it.
 *
 * `null` is "not answered yet", kept apart from "answered, nothing satisfied" for the same
 * reason `capabilitiesKnown` is kept apart there: a reader explaining *why* an app is
 * unavailable must not claim a capability is missing on the strength of the boot-time
 * assumption. It also means a sync that never ran reads as permanently unanswered —
 * `useCapabilities().known` stays false — rather than as a server with no framework.
 *
 * Read by `sdk/useCapabilities.ts`, which is on `@mica/sdk/core` only. There is no host
 * facet and no iframe twin for it, deliberately: see that file.
 */
export const satisfiedCapabilities = writable<ReadonlySet<AppCapability> | null>(null);
