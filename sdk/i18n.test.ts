// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { __resetMessages, availableLocales, locale, plural, registerMessages, t } from './i18n';

afterEach(() => {
  __resetMessages();
  locale.set('en');
});

describe('i18n', () => {
  it('resolves a key under the active locale and interpolates params', () => {
    registerMessages('notes', {
      en: { saved: 'Note saved', hello: 'Hello, {name}' },
      de: { saved: 'Notiz gespeichert' }
    });
    expect(get(t)('notes.saved')).toBe('Note saved');
    expect(get(t)('notes.hello', { name: 'Trevor' })).toBe('Hello, Trevor');
    locale.set('de');
    expect(get(t)('notes.saved')).toBe('Notiz gespeichert');
  });

  it('falls back to the language, then English, then the key itself', () => {
    registerMessages('notes', { en: { saved: 'Note saved' }, pt: { saved: 'Nota salva' } });
    locale.set('pt-BR');
    expect(get(t)('notes.saved')).toBe('Nota salva');
    locale.set('de');
    expect(get(t)('notes.saved')).toBe('Note saved');
    expect(get(t)('notes.missing')).toBe('notes.missing');
    expect(get(t)('nowhere.at.all')).toBe('nowhere.at.all');
  });

  it('re-derives when a catalog arrives after the first read', () => {
    registerMessages('notes', { en: { saved: 'Note saved' } });
    locale.set('de');
    expect(get(t)('notes.saved')).toBe('Note saved');
    registerMessages('notes', { de: { saved: 'Notiz gespeichert' } });
    expect(get(t)('notes.saved')).toBe('Notiz gespeichert');
    // The merge kept English.
    locale.set('en');
    expect(get(t)('notes.saved')).toBe('Note saved');
  });

  it('picks the plural category the locale needs', () => {
    registerMessages('notes', {
      en: { 'count.one': '{count} note', 'count.other': '{count} notes' }
    });
    expect(plural('notes.count', 1)).toBe('1 note');
    expect(plural('notes.count', 3)).toBe('3 notes');
  });

  it('lists every locale any catalog provides, English first', () => {
    registerMessages('notes', { en: {}, de: {} });
    registerMessages('shell', { en: {}, fr: {} });
    expect(availableLocales()).toEqual(['en', 'de', 'fr']);
  });

  it('refuses a namespace that is not an app id', () => {
    expect(() => registerMessages('Notes App', { en: {} })).toThrow(/app id/);
  });
});
