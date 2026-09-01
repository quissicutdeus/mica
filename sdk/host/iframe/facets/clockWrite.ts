// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['clockWrite']>>;

/** Implementation of the `useClockWrite` facet — see the inProcess twin for the usage contract. */
export function clockWrite(): Twin {
  return {
    setIs24Hour: fn('clockWrite', [], 'setIs24Hour')
  };
}

registerFacet('clockWrite', clockWrite);
