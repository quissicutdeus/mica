// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['keybindsWrite']>>;

/** Implementation of the `useKeybindsWrite` facet — see the inProcess twin for the usage contract. */
export function keybindsWrite(): Twin {
  return {
    setBinding: fn('keybindsWrite', [], 'setBinding'),
    resetBindings: fn('keybindsWrite', [], 'resetBindings')
  };
}

registerFacet('keybindsWrite', keybindsWrite);
