// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['streamerMode']>>;

/**
 * Streamer mode (MICA-249) as a frame sees it: both stores live over the wire, and
 * `setStreamerMode` is wired for shape and refused by the host's `FACET_MEMBERS` row.
 */
export function streamerMode(): Twin {
  return {
    streamerMode: store('streamerMode', [], 'streamerMode', false),
    revealGeneration: store('streamerMode', [], 'revealGeneration', 0),
    setStreamerMode: fn('streamerMode', [], 'setStreamerMode')
  };
}

registerFacet('streamerMode', streamerMode);
