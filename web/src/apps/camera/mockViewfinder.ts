// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { placeholderPhotos } from '@mica/sdk';

/**
 * Stand-in viewfinder frames for browser development.
 *
 * In game the viewfinder is the world showing through a transparent NUI, so there is
 * nothing to load. A browser has no world, and a black rectangle makes the whole app
 * look broken while developing.
 *
 * Generated rather than hotlinked (MICA-35), so a viewfinder looks right on a plane.
 *
 * Held here rather than pulled from `web/src/mocks/`. An app reaching into the shell's
 * mock registry does not resolve for an add-on installed from the Store, and
 * re-exporting from there would satisfy the letter of that rule while breaking it — the
 * import still crosses the boundary, just one file further away. These are the camera's
 * own dev fixtures and nothing else reads them.
 */
export const sampleAvatars = placeholderPhotos('mica-viewfinder', 6);
