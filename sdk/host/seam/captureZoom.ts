// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';

/**
 * Whether the phone should draw at its largest normal size, overriding the player's
 * Display setting, so a screen capture around it gets more real pixels.
 *
 * MICA-172. This lived in `shell/state/display.ts` and was read by
 * `sdk/useCaptureZoomBoost` — one of the last value edges out of the SDK into the shell.
 * The store itself is a bare `writable<boolean>` with no shell dependency of its own, so
 * it moves to the side of the boundary that publishes it and `display.ts` reads it back
 * (`web/` importing the SDK is the direction that is allowed to exist).
 *
 * `core: true` only — `@mica/sdk/core`, not `@mica/sdk`. It is a lever on the shell's
 * own rendering, and a sandboxed iframe forcing the whole phone bigger is a griefing
 * vector rather than a feature, which is why it has no host-protocol twin.
 */
export const captureZoomBoost = writable<boolean>(false);
