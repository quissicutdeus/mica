// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, writable } from 'svelte/store';
import { usePersisted } from '@mica/sdk';
import { callOr } from '../../nui/call';
import { shellContract } from '@mica/shared/contracts/shell';
import { FALLBACK_LOCALE, locale, registerMessages } from '../../../../sdk/i18n';

/**
 * Which language the phone is in (MICA-61), resolved from three sources in order:
 *
 * 1. the player's own choice in Settings > Language, persisted like every other setting;
 * 2. the server's default, the `mica_locale` convar, so an owner sets a community's
 *    language once (`shell:locale`);
 * 3. the browser's language — in game that is the player's OS language — then English.
 *
 * The result is written into the SDK's `locale` store, which every `$t` derives from, so
 * this file is the only writer of that store in the shell.
 */
const TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** A BCP 47 tag or '', lowercasing the language and keeping any region as sent. */
export const normalizeLocale = (raw: unknown): string => {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const [language, ...rest] = trimmed.split('-');
  const tag = [language.toLowerCase(), ...rest].join('-');
  return TAG.test(tag) ? tag : '';
};

/** The player's choice; '' means "follow the server, then the browser". */
export const localeSetting = usePersisted<string>('settings', 'locale', '', {
  sanitize: normalizeLocale
});

/** The owner's default, as `refreshLocale` last read it. */
export const serverLocale = writable<string>('');

const browserLocale = (): string =>
  normalizeLocale(typeof navigator !== 'undefined' ? navigator.language : '');

export const effectiveLocale = derived(
  [localeSetting, serverLocale],
  ([$setting, $server]) => $setting || $server || browserLocale() || FALLBACK_LOCALE
);

effectiveLocale.subscribe((next) => locale.set(next));

export const setLocale = (next: string): void => {
  localeSetting.set(normalizeLocale(next));
};

/** Ask the server for its default. Quiet: it may run before a character is loaded. */
export async function refreshLocale(): Promise<void> {
  const reply = await callOr(shellContract, 'locale', undefined, { locale: '' }, { quiet: true });
  serverLocale.set(normalizeLocale(reply?.locale));
}

/**
 * Languages an owner added on disk (`<resource>/locales/<lang>/<namespace>.json`), as
 * `shell:locales` last answered. Empty until boot has asked, and on failure.
 */
export const serverLanguages = writable<string[]>([]);

/** Languages whose catalog is fetched or in flight; a failed fetch leaves it, so it retries. */
const requested = new Set<string>();

/**
 * Fetch one language's disk catalog and merge it over the bundled strings. A failure keeps
 * whatever is bundled — the UI is never blanked, and `t` already falls back per key to en.
 */
export async function loadCatalog(language: string): Promise<void> {
  if (requested.has(language)) return;
  requested.add(language);
  const reply = await callOr(shellContract, 'catalog', { locale: language }, null, {
    quiet: true
  });
  const catalogs = reply?.catalogs;
  if (!catalogs || typeof catalogs !== 'object') {
    requested.delete(language);
    return;
  }
  for (const [namespace, messages] of Object.entries(catalogs)) {
    try {
      if (messages && typeof messages === 'object')
        registerMessages(namespace, { [language]: messages });
    } catch {
      // A namespace name `registerMessages` refuses is skipped, not fatal.
    }
  }
}

/** Ask the server which languages it has on disk. Quiet, like `refreshLocale`. */
export async function refreshServerLanguages(): Promise<void> {
  const reply = await callOr(shellContract, 'locales', undefined, null, { quiet: true });
  const list = Array.isArray(reply?.languages) ? reply.languages : [];
  const tags = list.map(normalizeLocale).filter((tag) => tag !== '');
  // An empty catalog makes the language show up in `availableLocales()` — which Settings,
  // an app that cannot import shell state, reads — before its strings have arrived.
  for (const tag of tags) registerMessages('shell', { [tag]: {} });
  serverLanguages.set(tags);
}

// Whenever the language or the server's list changes, load what the server has for it: the
// language itself, its base (`pt-BR` -> `pt`), and English, since an owner may override the
// fallback too.
derived([effectiveLocale, serverLanguages], ([$locale, $languages]) => [
  ...new Set(
    [$locale, $locale.split('-')[0], FALLBACK_LOCALE].filter((l) => $languages.includes(l))
  )
]).subscribe((wanted) => {
  for (const language of wanted) void loadCatalog(language);
});
