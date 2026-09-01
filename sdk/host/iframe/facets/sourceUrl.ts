// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['sourceUrl']>>;

export function sourceUrl(): Twin {
  return {
    sourceUrl: store('sourceUrl', [], 'sourceUrl', ''),
    refreshSourceUrl: fn('sourceUrl', [], 'refreshSourceUrl')
  };
}

registerFacet('sourceUrl', sourceUrl as unknown as Facets['sourceUrl']);
