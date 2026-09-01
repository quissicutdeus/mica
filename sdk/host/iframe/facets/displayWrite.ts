// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['displayWrite']>>;

/** Implementation of the `useDisplayWrite` facet — see the inProcess twin for the usage contract. */
export function displayWrite(): Twin {
  return {
    setDisplaySize: fn('displayWrite', [], 'setDisplaySize'),
    setMotionPreference: fn('displayWrite', [], 'setMotionPreference'),
    setHomeGridSize: fn('displayWrite', [], 'setHomeGridSize')
  };
}

registerFacet('displayWrite', displayWrite);
