// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['bank']>>;

export function bank(): Twin {
  return {
    sendMoney: fn('bank', [], 'sendMoney')
  };
}
// Unlike every other facet twin, no `as unknown as Facets['bank']` here: `bank` has no
// store member for `AsTwin` to collapse to `Readable`, so `Twin` is already structurally
// identical to `Facets['bank']` and the cast is flagged as dead by
// `@typescript-eslint/no-unnecessary-type-assertion` rather than doing anything.
registerFacet('bank', bank);
