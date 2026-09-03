// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, writable } from 'svelte/store';
import { usePersisted } from '@gos/sdk';
import { callOr } from '../../nui/call';
import { shellContract } from '@gos/shared/contracts/shell';
import { FALLBACK_LOCALE, locale } from '../../../../sdk/i18n';

/**
 * Which language the phone is in (MICA-61), resolved from three sources in order:
 *
 * 1. the player's own choice in Settings > Language, persisted like every other setting;
 * 2. the server's default, the `gos_locale` convar, so an owner sets a community's
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
