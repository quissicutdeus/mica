// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import { effectiveLocale, setLocale } from '../../shell/state/locale';

export function localeFacet() {
  return { locale: effectiveLocale, setLocale };
}

registerFacet('locale', localeFacet);
