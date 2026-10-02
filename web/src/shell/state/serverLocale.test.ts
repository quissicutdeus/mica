// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

/** Fresh module graph per test, the transport stubbed the way `ownerConfig.test.ts` does. */
const load = async (replies: Record<string, unknown>) => {
  vi.resetModules();
  const fetchNui = vi.fn(
    async (_e: string, data: { action: string; data?: { locale?: string } }, o?: any) => {
      const key = data.action === 'catalog' ? `catalog:${data.data?.locale}` : data.action;
      const reply = replies[key];
      if (reply instanceof Error) return o?.defaultValue;
      return reply ?? o?.defaultValue;
    }
  );
  vi.doMock('../../nui/fetchNui', () => ({ fetchNui }));
  await import('../../host/registerFacets');
  const i18n = await import('../../../../sdk/i18n');
  const state = await import('./locale');
  return { ...state, ...i18n, fetchNui };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('server-provided languages (MICA-235)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists a language only the server knows', async () => {
    const m = await load({ locales: { languages: ['en', 'fr'] } });
    await m.refreshServerLanguages();
    expect(get(m.serverLanguages)).toEqual(['en', 'fr']);
    expect(m.availableLocales()).toContain('fr');
  });

  it('registers its catalog on switch, and a missing key falls back to en', async () => {
    const m = await load({
      locales: { languages: ['en', 'fr'] },
      'catalog:fr': { catalogs: { notes: { title: 'Notes FR' } } },
      'catalog:en': { catalogs: {} }
    });
    m.registerMessages('notes', { en: { title: 'Notes', other: 'Other' } });
    await m.refreshServerLanguages();
    m.setLocale('fr');
    await flush();
    const tr = get(m.t);
    expect(tr('notes.title')).toBe('Notes FR');
    expect(tr('notes.other')).toBe('Other');
  });

  it('a disk catalog overrides a bundled string', async () => {
    const m = await load({
      locales: { languages: ['en'] },
      'catalog:en': { catalogs: { notes: { title: 'Jotter' } } }
    });
    m.registerMessages('notes', { en: { title: 'Notes' } });
    await m.refreshServerLanguages();
    await flush();
    expect(get(m.t)('notes.title')).toBe('Jotter');
  });

  it('a failed fetch keeps bundled strings and retries next time', async () => {
    const m = await load({ locales: { languages: ['en', 'fr'] } });
    m.registerMessages('notes', { en: { title: 'Notes' } });
    await m.refreshServerLanguages();
    m.setLocale('fr');
    await flush();
    expect(get(m.t)('notes.title')).toBe('Notes');
    const calls = m.fetchNui.mock.calls.length;
    await m.loadCatalog('fr');
    expect(m.fetchNui.mock.calls.length).toBe(calls + 1);
  });

  it('one language load re-derives t once, however many namespaces it carries', async () => {
    const m = await load({
      'catalog:de': {
        catalogs: {
          notes: { title: 'Notizen' },
          bank: { sent: 'Gesendet' },
          mail: { inbox: 'Posteingang' },
          shell: { home: 'Start' },
          'Not An Id': { title: 'never' },
          clock: { alarm: 'Wecker' }
        }
      }
    });
    let emissions = -1;
    const stop = m.t.subscribe(() => emissions++);
    await m.loadCatalog('de');
    stop();
    expect(emissions).toBe(1);
    // The refused namespace was skipped; every other one landed.
    m.locale.set('de');
    const tr = get(m.t);
    expect(tr('notes.title')).toBe('Notizen');
    expect(tr('clock.alarm')).toBe('Wecker');
    expect(m.catalogFor('shell', 'de')).toEqual({ home: 'Start' });
  });

  it('a failed language list leaves the list empty', async () => {
    const m = await load({});
    await m.refreshServerLanguages();
    expect(get(m.serverLanguages)).toEqual([]);
  });
});
