// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['systemHardwareWrite']>>;

/** Implementation of the `useSystemHardwareWrite` facet — see the inProcess twin for the usage contract. */
export function systemHardwareWrite(): Twin {
  return {
    setCharge: fn('systemHardwareWrite', [], 'setCharge'),
    setSignal: fn('systemHardwareWrite', [], 'setSignal'),
    toggleCellService: fn('systemHardwareWrite', [], 'toggleCellService'),
    toggleBluetooth: fn('systemHardwareWrite', [], 'toggleBluetooth'),
    setVolume: fn('systemHardwareWrite', [], 'setVolume'),
    toggleMute: fn('systemHardwareWrite', [], 'toggleMute'),
    setVolumeStep: fn('systemHardwareWrite', [], 'setVolumeStep'),
    setRingMode: fn('systemHardwareWrite', [], 'setRingMode'),
    setRingtone: fn('systemHardwareWrite', [], 'setRingtone'),
    previewRingtone: fn('systemHardwareWrite', [], 'previewRingtone')
  };
}

registerFacet('systemHardwareWrite', systemHardwareWrite);
