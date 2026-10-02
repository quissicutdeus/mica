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
 * Validate one namespace and merge its locales into the registry, without bumping
 * `revision`. Throws, before touching the registry, on a namespace that is not an app id.
 */
const mergeMessages = (namespace: string, catalog: Catalog): void => {
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
};

/**
 * Declare a namespace's strings. Called once per app at module scope; a second call for
 * the same namespace **merges** locales, so an app may register `en` eagerly and another
 * locale when it arrives. A key is `<namespace>.<name>`; the namespace is an app id, the
 * shell's own is `shell`, and the SDK's primitives use `ui`.
 */
export function registerMessages(namespace: string, catalog: Catalog): void {
  mergeMessages(namespace, catalog);
  revision.update((n) => n + 1);
}

/**
 * Register many namespaces at once and bump `revision` a single time, so `t` re-derives
 * once rather than once per namespace. Each entry is validated and merged exactly as
 * `registerMessages` would; one it would refuse is skipped, not fatal, and the rest still
 * land. Returns the namespaces refused. Synchronous, like `registerMessages`.
 *
 * The shell's disk-catalog load (`web/src/shell/state/locale.ts`) is the caller: one
 * language arrives as ~20 namespaces, and a bump per namespace re-translated every `$t`
 * and re-sent every open add-on frame its strings that many times. Not re-exported from an
 * entry point — an app registers its own namespace, one call, and has no batch to send.
 */
export function registerMessagesMany(entries: Iterable<readonly [string, Catalog]>): string[] {
  const refused: string[] = [];
  let landed = false;
  for (const [namespace, catalog] of entries) {
    try {
      mergeMessages(namespace, catalog);
      landed = true;
    } catch {
      refused.push(namespace);
    }
  }
  if (landed) revision.update((n) => n + 1);
  return refused;
}

/**
 * Bumps whenever any catalog is registered (MICA-235). Read-only; the host's `locale` facet
 * watches it so a sandboxed add-on's frame is re-sent its strings when an owner's
 * `locales/` files arrive after the frame booted. Not re-exported from an entry point.
 */
export const catalogRevision: Readable<number> = { subscribe: revision.subscribe };

/**
 * The strings this bundle holds for one namespace in exactly one locale — no fallback walk
 * — or `undefined` if it holds none (MICA-235). A copy, so a caller cannot mutate the
 * registry. Not re-exported from an entry point: the shell reads it to hand an add-on its
 * own namespace, and nothing else has a reason to.
 */
export function catalogFor(namespace: string, localeTag: string): Messages | undefined {
  const messages = catalogs.get(namespace)?.[localeTag];
  return messages ? { ...messages } : undefined;
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
 * server's `mica_locale` convar and the browser's own language in that order; an add-on
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
 * The locales a key is looked up under, in order: `pt-BR` → `pt` → `en`, deduplicated so
 * `en` walks once. Built once per tag, not once per key.
 */
const chains = new Map<string, readonly string[]>();
const chainFor = (active: string): readonly string[] => {
  let chain = chains.get(active);
  if (!chain) {
    chain = [...new Set([active, active.split('-')[0], FALLBACK_LOCALE])];
    chains.set(active, chain);
  }
  return chain;
};

/** Look a key up along a locale chain from `chainFor`. */
const lookup = (key: string, chain: readonly string[]): string | undefined => {
  const dot = key.indexOf('.');
  if (dot <= 0) return undefined;
  const catalog = catalogs.get(key.slice(0, dot));
  if (!catalog) return undefined;
  const name = key.slice(dot + 1);
  for (const candidate of chain) {
    const hit = catalog[candidate]?.[name];
    if (hit !== undefined) return hit;
  }
  return undefined;
};

const translate = (
  key: string,
  params: TranslateParams | undefined,
  active: string,
  chain: readonly string[]
): string => {
  const found = lookup(key, chain);
  if (found === undefined) {
    if (!reported.has(key)) {
      reported.add(key);
      console.warn(`[i18n] no message for '${key}' in '${active}' or '${FALLBACK_LOCALE}'`);
    }
    return key;
  }
  return interpolate(found, params);
};

const translateFor = (active: string): Translate => {
  const chain = chainFor(active);
  return (key, params) => translate(key, params, active, chain);
};

/**
 * The translator, as a store, so a component re-renders when the locale changes or a
 * catalog arrives: `$t('notes.saved')`, `$t('notes.count', { count })`.
 */
export const t: Readable<Translate> = derived([locale, revision], ([$locale]) =>
  translateFor($locale)
);

/** One `Intl.PluralRules` per locale tag, built on first use rather than per call. */
const pluralRules = new Map<string, Intl.PluralRules>();
const pluralRulesFor = (active: string): Intl.PluralRules => {
  let rules = pluralRules.get(active);
  if (!rules) {
    rules = new Intl.PluralRules(active);
    pluralRules.set(active, rules);
  }
  return rules;
};

/**
 * A plural form, chosen by `Intl.PluralRules` for the active locale. The catalog holds
 * one entry per category the language needs — `notes.count.one`, `notes.count.other` —
 * and `{count}` is interpolated into whichever is picked. Falls back to `other`.
 */
export function plural(key: string, count: number, params?: TranslateParams): string {
  const active = get(locale);
  const chain = chainFor(active);
  const category = pluralRulesFor(active).select(count);
  const withCount = { count, ...params };
  const specific = lookup(`${key}.${category}`, chain);
  if (specific !== undefined) return interpolate(specific, withCount);
  return translate(`${key}.other`, withCount, active, chain);
}

/** Test seam: forget every catalog. Never called by the phone. */
export function __resetMessages(): void {
  catalogs.clear();
  reported.clear();
  revision.update((n) => n + 1);
}
