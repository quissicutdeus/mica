// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';
import { locale as bundleLocale, registerMessages, type Catalog } from '../../../i18n';

type Twin = AsTwin<ReturnType<Facets['locale']>>;

let following = false;

/**
 * The shell's locale, mirrored into this bundle's own `locale` store the first time it is
 * asked for — `bootAddOn` asks before mounting — so the SDK's `t` inside the frame
 * re-derives when the player changes language. `setLocale` is wired for shape and refused
 * by the host's allowlist.
 *
 * `catalogs` (MICA-235) is how an owner's `locales/<lang>/<namespace>.json` files reach a
 * frame: the shell's strings for this add-on's own namespace and `ui`, merged into this
 * bundle's registry as they arrive. No app id is sent — the shell pins the facet to the
 * frame it is talking to, so there is nothing here to name another app with.
 */
export function locale(): Twin {
  const remote = store('locale', [], 'locale', 'en');
  const disk = store<Readonly<Record<string, Catalog>>>('locale', [], 'catalogs', {});
  if (!following) {
    following = true;
    remote.subscribe((next) => bundleLocale.set(next));
    disk.subscribe((next) => {
      for (const [namespace, catalog] of Object.entries(next)) {
        try {
          registerMessages(namespace, catalog);
        } catch (e) {
          console.warn(`[i18n] shell sent an unusable catalog for '${namespace}':`, e);
        }
      }
    });
  }
  return {
    locale: remote,
    catalogs: disk,
    setLocale: fn('locale', [], 'setLocale')
  };
}

registerFacet('locale', locale);
