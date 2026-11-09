// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';

/**
 * Whether the home screen has what it needs to be drawn correctly (MICA-450).
 *
 * True once the current bootstrap run's shell reads have settled -- the admin check,
 * capabilities, the locale and server languages, the owner's config and the image host
 * (`bootstrapStores`, `state/bootstrap.ts`). Those decide which icons the launcher draws, in
 * which language, and the dock; until they answer, home can still change under the player.
 * The app preloads are deliberately not part of it: they are deferred past the open and
 * needed only before an *app* is shown.
 *
 * "Settled", not "succeeded": a refused or failed read leaves the cached value, which is what
 * home will show anyway, so waiting longer buys nothing. Back to false when the bootstrap is
 * reset for a new device or character, until that run's reads settle.
 *
 * Its own module rather than an export of `bootstrap.ts`, so `state/power.ts` (the boot
 * screen's only reader) does not import every service the bootstrap loads.
 */
export const shellReady = writable(false);
