// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get, writable, type Readable } from 'svelte/store';

/**
 * Strings, by locale, for one namespace (MICA-61).
 *
 * The phone had no translation layer at all: every label, empty state and toast was an
 * English literal in a `.svelte` file, and a server owner whose community does not speak
 * English could do nothing about it short of forking every app. This is the smallest
 * mechanism that fixes that and stays honest about what a phone bundle can afford — a
 * catalog is a flat object of strings, a namespace is an app id, and there is no runtime
 * dependency, because every kilobyte here is paid on every phone open in CEF.
 *
 * **Every app registers its own catalog**, core or not. That is the design decision that
 * matters: an add-on installed from the Store is not in this repository, so a central
 * catalog it cannot add to would leave it permanently English. `registerMessages('notes',
 * { en, de })` at module scope is all an app does; `$t('notes.saved')` is all it reads.
 *
 * Fallback is English, then the key itself, and a missing key is reported once per key in
 * development so a half-translated locale shows its gaps without crashing the phone.
 */
export type Messages = Readonly<Record<string, string>>;
export type Catalog = Readonly<Record<string, Messages>>;
export type TranslateParams = Readonly<Record<string, string | number>>;
export type Translate = (key: string, params?: TranslateParams) => string;

export const FALLBACK_LOCALE = 'en';

const catalogs = new Map<string, Catalog>();
/** Bumped on every registration so `t` re-derives; catalogs are module state, not a store. */
const revision = writable(0);
const reported = new Set<string>();

/**
 * Declare a namespace's strings. Called once per app at module scope; a second call for
 * the same namespace **merges** locales, so an app may register `en` eagerly and another
 * locale when it arrives. A key is `<namespace>.<name>`; the namespace is an app id, the
 * shell's own is `shell`, and the SDK's primitives use `ui`.
 */
export function registerMessages(namespace: string, catalog: Catalog): void {
  if (!/^[a-z][a-z0-9_]*$/.test(namespace)) {
    throw new Error(
      `registerMessages('${namespace}'): a namespace is an app id — lowercase, digits and ` +
        'underscores — because the key prefix has to be the thing a reader can look up.'
    );
  }
  const existing = catalogs.get(namespace) ?? {};
  const merged: Record<string, Messages> = { ...existing };
  for (const [locale, messages] of Object.entries(catalog)) {
    merged[locale] = { ...existing[locale], ...messages };
  }
  catalogs.set(namespace, merged);
  revision.update((n) => n + 1);
}

/** The locales any registered catalog provides, `en` first, for a Language picker. */
export function availableLocales(): string[] {
  const found = new Set<string>([FALLBACK_LOCALE]);
  for (const catalog of catalogs.values())
    for (const locale of Object.keys(catalog)) found.add(locale);
  return [FALLBACK_LOCALE, ...[...found].filter((l) => l !== FALLBACK_LOCALE).sort()];
}

/**
 * The active locale, a BCP 47 tag such as `en` or `pt-BR`. Written by the shell's locale
 * state (`web/src/shell/state/locale.ts`), which resolves the player's setting, the
 * server's `gphone_locale` convar and the browser's own language in that order; an add-on
 * reads it through `useLocale()` and never sets it.
 */
export const locale = writable<string>(FALLBACK_LOCALE);

const interpolate = (template: string, params?: TranslateParams): string =>
  params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in params ? String(params[name]) : match
      )
    : template;

/**
 * Look a key up under a locale, walking `pt-BR` → `pt` → `en`.
 */
const lookup = (key: string, active: string): string | undefined => {
  const dot = key.indexOf('.');
  if (dot <= 0) return undefined;
  const catalog = catalogs.get(key.slice(0, dot));
  if (!catalog) return undefined;
  const name = key.slice(dot + 1);
  const chain = [active, active.split('-')[0], FALLBACK_LOCALE];
  for (const candidate of chain) {
    const hit = catalog[candidate]?.[name];
    if (hit !== undefined) return hit;
  }
  return undefined;
};

const translateFor =
  (active: string): Translate =>
  (key, params) => {
    const found = lookup(key, active);
    if (found === undefined) {
      if (!reported.has(key)) {
        reported.add(key);
        console.warn(`[i18n] no message for '${key}' in '${active}' or '${FALLBACK_LOCALE}'`);
      }
      return key;
    }
    return interpolate(found, params);
  };

/**
 * The translator, as a store, so a component re-renders when the locale changes or a
 * catalog arrives: `$t('notes.saved')`, `$t('notes.count', { count })`.
 */
export const t: Readable<Translate> = derived([locale, revision], ([$locale]) =>
  translateFor($locale)
);

/**
 * A plural form, chosen by `Intl.PluralRules` for the active locale. The catalog holds
 * one entry per category the language needs — `notes.count.one`, `notes.count.other` —
 * and `{count}` is interpolated into whichever is picked. Falls back to `other`.
 */
export function plural(key: string, count: number, params?: TranslateParams): string {
  const active = get(locale);
  const category = new Intl.PluralRules(active).select(count);
  const translate = translateFor(active);
  const withCount = { count, ...params };
  const specific = lookup(`${key}.${category}`, active);
  if (specific !== undefined) return interpolate(specific, withCount);
  return translate(`${key}.other`, withCount);
}

/** Test seam: forget every catalog. Never called by the phone. */
export function __resetMessages(): void {
  catalogs.clear();
  reported.clear();
  revision.update((n) => n + 1);
}
