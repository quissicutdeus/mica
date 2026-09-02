// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';
import { locale as bundleLocale } from '../../../i18n';

type Twin = AsTwin<ReturnType<Facets['locale']>>;

let following = false;

/**
 * The shell's locale, mirrored into this bundle's own `locale` store the first time it is
 * asked for, so the SDK's `t` inside the frame re-derives when the player changes language.
 * `setLocale` is wired for shape and refused by the host's allowlist.
 */
export function locale(): Twin {
  const remote = store('locale', [], 'locale', 'en');
  if (!following) {
    following = true;
    remote.subscribe((next) => bundleLocale.set(next));
  }
  return {
    locale: remote,
    setLocale: fn('locale', [], 'setLocale') as unknown as Twin['setLocale']
  };
}

registerFacet('locale', locale as unknown as Facets['locale']);
