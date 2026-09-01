// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['lockScreen']>>;

export function lockScreen(): Twin {
  return {
    hasPasscode: store('lockScreen', [], 'hasPasscode', false),
    autoLockPolicy: store('lockScreen', [], 'autoLockPolicy', 'onClose'),
    autoLockPolicyChoices: store('lockScreen', [], 'autoLockPolicyChoices', [])
  };
}

registerFacet('lockScreen', lockScreen as unknown as Facets['lockScreen']);
