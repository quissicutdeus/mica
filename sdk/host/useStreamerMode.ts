// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * Streamer mode (MICA-249): whether the player asked for every player-supplied picture to
 * be blurred until it is tapped, and when a revealed one should hide again.
 *
 * `MediaThumb` honours this for every surface that draws through it, so an app that only
 * ever renders pictures with that primitive has nothing to do. An app drawing a picture
 * of its own — a `core: false` add-on with its own service — reads `streamerMode` and
 * blurs when it is on, and re-blurs on every change of `revealGeneration`: it bumps when
 * the flag flips, when the foreground app changes and when the device closes.
 *
 * Implicit, like `useLocale`: one boolean, no player data. `setStreamerMode` is Settings'
 * and is refused to an add-on by `FACET_MEMBERS`.
 */
export function useStreamerMode() {
  return guarded('useStreamerMode').facets.streamerMode();
}
