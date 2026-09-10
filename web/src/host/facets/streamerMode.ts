// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import { revealGeneration, setStreamerMode, streamerMode } from '../../shell/state/streamerMode';

/** Streamer mode (MICA-249). The shell's own stores, handed through unchanged. */
export function streamerModeFacet() {
  return { streamerMode, revealGeneration, setStreamerMode };
}

registerFacet('streamerMode', streamerModeFacet);
