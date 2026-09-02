// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';
import { availableLocales, plural, t } from '../i18n';

/**
 * The phone's language (MICA-61): the active locale, the translator, and — for Settings
 * only — the way to change it.
 *
 * `t` is the same derived store whether an app runs in-process or in a sandboxed frame,
 * because catalogs are registered in the bundle that reads them; only `locale` crosses
 * the host seam. `setLocale` is refused to an add-on by `MEMBER_ALLOWLIST`.
 */
export function useLocale() {
  const facet = guarded('useLocale').facets.locale();
  return { locale: facet.locale, setLocale: facet.setLocale, t, plural, availableLocales };
}
