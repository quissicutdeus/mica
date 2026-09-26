// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readable, type Readable } from 'svelte/store';
import { registerFacet } from '../../../../sdk/host/current';
import {
  catalogFor,
  catalogRevision,
  FALLBACK_LOCALE,
  type Catalog,
  type Messages
} from '../../../../sdk/i18n';
import { effectiveLocale, setLocale } from '../../shell/state/locale';

type Catalogs = Readonly<Record<string, Catalog>>;

/** The namespaces an app may be handed: its own, and the SDK primitives' `ui`. Never another's. */
const namespacesOf = (appId: string): readonly string[] =>
  appId === 'ui' ? ['ui'] : [appId, 'ui'];

/**
 * What the shell's registry holds for `appId`'s namespaces along the fallback chain —
 * `active`, its base language, then `en` (MICA-235). `en` is included because an owner's
 * disk catalog may override a bundled English string, and a frame registers its own
 * English at module scope, before this arrives to merge over it.
 */
function catalogsFor(appId: string, active: string): Catalogs {
  const chain = [...new Set([active, active.split('-')[0], FALLBACK_LOCALE])];
  const out: Record<string, Catalog> = {};
  for (const namespace of namespacesOf(appId)) {
    const catalog: Record<string, Messages> = {};
    for (const tag of chain) {
      const messages = catalogFor(namespace, tag);
      if (messages) catalog[tag] = messages;
    }
    if (Object.keys(catalog).length > 0) out[namespace] = catalog;
  }
  return out;
}

const EMPTY: Catalogs = Object.freeze({});

/**
 * Re-derived on a locale change or any registration, but only *emitted* when this app's
 * slice actually changed: every catalog anywhere bumps the revision, and each emission is a
 * `postMessage` to a frame.
 */
function catalogsStore(appId: string | undefined): Readable<Catalogs> {
  if (!appId) return readable(EMPTY);
  return readable(EMPTY, (set) => {
    let active = FALLBACK_LOCALE;
    let last = JSON.stringify(EMPTY);
    const recompute = () => {
      const next = catalogsFor(appId, active);
      const encoded = JSON.stringify(next);
      if (encoded === last) return;
      last = encoded;
      set(next);
    };
    const stopLocale = effectiveLocale.subscribe((next) => {
      active = next;
      recompute();
    });
    const stopRevision = catalogRevision.subscribe(recompute);
    return () => {
      stopLocale();
      stopRevision();
    };
  });
}

/**
 * MICA-61, MICA-235. `appId` is pinned to the calling add-on by `IframeHostServer`'s
 * `APP_SCOPED_FACETS`, so `catalogs` can only ever be a frame's own namespace and `ui`.
 */
export function localeFacet(appId?: string) {
  return { locale: effectiveLocale, setLocale, catalogs: catalogsStore(appId) };
}

registerFacet('locale', localeFacet);
