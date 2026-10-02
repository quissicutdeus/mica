// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  __resetMessages,
  availableLocales,
  catalogRevision,
  locale,
  plural,
  registerMessages,
  registerMessagesMany,
  t
} from './i18n';

afterEach(() => {
  __resetMessages();
  locale.set('en');
  vi.restoreAllMocks();
});

/** Every value `t` emits from now on, the subscription's own first call excluded. */
const countEmissions = () => {
  let count = -1;
  const stop = t.subscribe(() => count++);
  return { count: () => count, stop };
};

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

  it('reports a missing key once, however often it is read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerMessages('notes', { en: {} });
    const tr = get(t);
    expect(tr('notes.gone')).toBe('notes.gone');
    expect(tr('notes.gone')).toBe('notes.gone');
    locale.set('de');
    expect(get(t)('notes.gone')).toBe('notes.gone');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('registerMessagesMany', () => {
  it('re-derives t exactly once for a batch of namespaces', () => {
    const seen = countEmissions();
    let revisions = -1;
    const stopRevision = catalogRevision.subscribe(() => revisions++);
    registerMessagesMany([
      ['notes', { de: { saved: 'Notiz gespeichert' } }],
      ['bank', { de: { sent: 'Gesendet' } }],
      ['mail', { de: { inbox: 'Posteingang' } }],
      ['shell', { de: { home: 'Start' } }]
    ]);
    expect(seen.count()).toBe(1);
    expect(revisions).toBe(1);
    seen.stop();
    stopRevision();
    locale.set('de');
    expect(get(t)('notes.saved')).toBe('Notiz gespeichert');
    expect(get(t)('shell.home')).toBe('Start');
  });

  it('skips a namespace registerMessages would refuse, and lands the rest', () => {
    const seen = countEmissions();
    const refused = registerMessagesMany([
      ['notes', { en: { saved: 'Note saved' } }],
      ['Notes App', { en: { saved: 'never' } }],
      ['bank', { en: { sent: 'Sent' } }]
    ]);
    expect(refused).toEqual(['Notes App']);
    expect(seen.count()).toBe(1);
    seen.stop();
    expect(get(t)('notes.saved')).toBe('Note saved');
    expect(get(t)('bank.sent')).toBe('Sent');
  });

  it('merges over what a namespace already holds, as registerMessages does', () => {
    registerMessages('notes', { en: { saved: 'Note saved', title: 'Notes' } });
    registerMessagesMany([['notes', { en: { title: 'Jotter' }, de: { title: 'Notizen' } }]]);
    expect(get(t)('notes.saved')).toBe('Note saved');
    expect(get(t)('notes.title')).toBe('Jotter');
    locale.set('de');
    expect(get(t)('notes.title')).toBe('Notizen');
  });

  it('does not re-derive t when nothing in the batch lands', () => {
    const seen = countEmissions();
    expect(registerMessagesMany([['Bad Name', { en: {} }]])).toEqual(['Bad Name']);
    expect(registerMessagesMany([])).toEqual([]);
    expect(seen.count()).toBe(0);
    seen.stop();
  });
});

describe('plural', () => {
  it('keeps each locale its own rules across switches', () => {
    registerMessages('notes', {
      en: { 'count.one': '{count} note', 'count.other': '{count} notes' },
      pl: {
        'count.one': '{count} notatka',
        'count.few': '{count} notatki',
        'count.many': '{count} notatek',
        'count.other': '{count} notatki'
      }
    });
    const read = () => [1, 2, 5].map((n) => plural('notes.count', n));
    const english = ['1 note', '2 notes', '5 notes'];
    const polish = ['1 notatka', '2 notatki', '5 notatek'];
    for (let round = 0; round < 2; round++) {
      locale.set('en');
      expect(read()).toEqual(english);
      locale.set('pl');
      expect(read()).toEqual(polish);
    }
  });

  it('builds one Intl.PluralRules per locale, not one per call', () => {
    registerMessages('notes', { cy: { 'count.other': '{count}' } });
    const Real = Intl.PluralRules;
    const built: string[] = [];
    vi.spyOn(Intl, 'PluralRules').mockImplementation(function (tag?: Intl.LocalesArgument) {
      built.push(String(tag));
      return new Real(tag);
    });
    // `cy` is used by no other test, so the module-level cache starts cold for it.
    locale.set('cy');
    for (let n = 0; n < 5; n++) expect(plural('notes.count', n)).toBe(String(n));
    locale.set('en');
    plural('notes.count', 1);
    locale.set('cy');
    plural('notes.count', 1);
    expect(built.filter((tag) => tag === 'cy')).toHaveLength(1);
  });

  it('falls back to other, then the key, through the same warn-once path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerMessages('notes', { en: { 'count.other': '{count} notes' } });
    expect(plural('notes.count', 1)).toBe('1 notes');
    expect(plural('notes.none', 1)).toBe('notes.none.other');
    expect(plural('notes.none', 2)).toBe('notes.none.other');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
