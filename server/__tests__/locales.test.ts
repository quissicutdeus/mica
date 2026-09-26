// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { handlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return { handlers: captured };
});
vi.mock('../lib/Database', () => ({ Database: { query: vi.fn(), single: vi.fn() } }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: 'CIT_A', source: 5, setMeta: () => {} })
  }
}));

import {
  __resetLocales,
  loadLocales,
  locales,
  MAX_FILE_BYTES,
  reloadLocales,
  reportCoverage
} from '../lib/locales';
import { __resetLocaleWarnings, serverLocale } from '../services/Source';
import { __resetRateLimits } from '../lib/rateLimit';

/**
 * Languages an owner adds by dropping files in (MICA-235). Every case here reads a real folder
 * on disk through the same code resource start runs — nothing is built, bundled or mocked
 * between the file and the answer.
 */

let root: string;

const write = (lang: string, namespace: string, content: unknown): void => {
  mkdirSync(join(root, lang), { recursive: true });
  writeFileSync(
    join(root, lang, `${namespace}.json`),
    typeof content === 'string' ? content : JSON.stringify(content)
  );
};

/** Drive a `shell` action the way a NUI request reaches it, and return what it answered. */
const ask = async (action: string, payload?: unknown): Promise<unknown> => {
  const handler = handlers.get(`mica:server:shell:${action}`);
  expect(handler, action).toBeDefined();
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler!('cb-1', payload);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mica-locales-'));
  write('en', 'notes', { title: 'Notes', empty: 'No notes yet' });
  write('en', 'shell', { lock: 'Lock' });
  __resetLocales();
  __resetLocaleWarnings();
  __resetRateLimits();
  (globalThis as any).GetConvar = (_name: string, fallback: string) => fallback;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('a language added by dropping files in', () => {
  it('appears in `locales` and `catalog` from a new xx/notes.json, with no build', async () => {
    write('xx', 'notes', { title: 'Xotes', empty: 'Xo xotes' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reloadLocales(root);

    expect(await ask('locales')).toEqual({ languages: ['en', 'xx'] });
    expect(await ask('catalog', { locale: 'xx' })).toEqual({
      catalogs: { notes: { title: 'Xotes', empty: 'Xo xotes' } }
    });
  });

  it('lists en first and always, then the rest sorted', () => {
    write('pt-BR', 'shell', { lock: 'Bloquear' });
    write('de', 'shell', { lock: 'Sperren' });
    rmSync(join(root, 'en'), { recursive: true });
    expect(loadLocales(root).languages).toEqual(['en', 'de', 'pt-BR']);
  });

  it('is English only, with no crash, when there is no locales folder', async () => {
    reloadLocales(join(root, 'nope'));
    expect(await ask('locales')).toEqual({ languages: ['en'] });
    expect(await ask('catalog', { locale: 'en' })).toEqual({ catalogs: {} });
  });

  it('answers a language it has no files for with no catalogs rather than an error', async () => {
    reloadLocales(root);
    expect(await ask('catalog', { locale: 'fr' })).toEqual({ catalogs: {} });
  });

  it('finds a language whatever case the tag is asked in', async () => {
    write('pt-BR', 'shell', { lock: 'Bloquear' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reloadLocales(root);
    expect(await ask('catalog', { locale: 'PT-BR' })).toEqual({
      catalogs: { shell: { lock: 'Bloquear' } }
    });
  });
});

describe('what a catalog request may name', () => {
  it.each([
    ['../en', 'a parent directory'],
    ['..', 'a bare parent'],
    ['en/../../etc', 'a path'],
    ['en\\notes', 'a backslash'],
    ['/etc/passwd', 'an absolute path'],
    ['', 'nothing']
  ])('refuses %s (%s) before any handler runs', async (locale) => {
    write('xx', 'notes', { title: 'Xotes' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reloadLocales(root);
    const reply = (await ask('catalog', { locale })) as Record<string, unknown> | undefined;
    // The contract refuses it with an error reply: no catalogs, and no file outside the folder
    // is read. Asserting the error, not only the absence, so a handler that never answered
    // cannot pass this.
    expect(reply).toMatchObject({ error: expect.any(String) });
    expect(reply?.catalogs).toBeUndefined();
  });
});

describe('files that cannot be used', () => {
  it('skips an invalid file with a warning and keeps the rest of the language', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    write('xx', 'notes', { title: 'Xotes' });
    write('xx', 'shell', '{ not json');
    write('xx', 'Bad-Name', { lock: 'x' });
    write('xx', 'ui', ['not', 'an', 'object']);
    write('xx', 'server', { ok: 'fine', nested: { no: 1 }, count: 3 });
    writeFileSync(join(root, 'xx', 'readme.txt'), 'ignored');

    const store = loadLocales(root);

    expect(store.catalogs.get('xx')).toEqual({ notes: { title: 'Xotes' }, server: { ok: 'fine' } });
    const said = warn.mock.calls.map(([m]) => String(m));
    expect(said.some((m) => m.includes('xx/shell.json') && m.includes('not valid JSON'))).toBe(
      true
    );
    expect(said.some((m) => m.includes("'Bad-Name' is not a namespace"))).toBe(true);
    expect(said.some((m) => m.includes('xx/ui.json') && m.includes('flat'))).toBe(true);
    expect(said.some((m) => m.includes('xx/server.json') && m.includes('nested, count'))).toBe(
      true
    );
    expect(said.some((m) => m.includes('readme'))).toBe(false);
  });

  it('skips a file over the size limit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    write('xx', 'notes', { big: 'x'.repeat(MAX_FILE_BYTES) });
    const store = loadLocales(root);
    expect(store.languages).toEqual(['en']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('over the'));
  });

  it('skips a folder that is not a language tag, and a language with no valid file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    write('not a tag', 'notes', { title: 'x' });
    write('zz', 'notes', '{ broken');
    expect(loadLocales(root).languages).toEqual(['en']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'not a tag' is not a language tag"));
  });
});

describe('the start-up coverage warning', () => {
  it('names each language’s missing and extra keys per namespace, with a count', () => {
    write('xx', 'notes', { title: 'Xotes', extra: 'Only here' });
    const lines = reportCoverage(loadLocales(root));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("'xx'");
    expect(lines[0]).toContain('notes: 1 missing (empty)');
    expect(lines[0]).toContain('notes: 1 not in en (extra)');
    expect(lines[0]).toContain('shell: 1 missing (lock)');
  });

  it('names at most ten keys and counts the rest', () => {
    const many = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, `v${i}`]));
    write('en', 'ui', many);
    write('xx', 'shell', { lock: 'x' });
    const [line] = reportCoverage(loadLocales(root));
    expect(line).toContain('ui: 15 missing (k0, k1, k2, k3, k4, k5, k6, k7, k8, k9, …)');
  });

  it('says nothing for a language that matches en exactly', () => {
    write('xx', 'notes', { title: 'a', empty: 'b' });
    write('xx', 'shell', { lock: 'c' });
    expect(reportCoverage(loadLocales(root))).toEqual([]);
  });

  it('is logged once per language when the folder is read at start', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    write('xx', 'notes', { title: 'Xotes' });
    write('yy', 'notes', { title: 'Yotes' });
    reloadLocales(root);
    const coverage = warn.mock.calls.filter(([m]) => String(m).includes('differs from en'));
    expect(coverage).toHaveLength(2);
  });
});

describe('mica_locale', () => {
  const withLocale = (value: string) => {
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_locale' ? value : fallback;
  };

  it('accepts any language present on disk, including one an owner added', () => {
    write('xx', 'notes', { title: 'Xotes' });
    write('pt-BR', 'notes', { title: 'Notas' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reloadLocales(root);
    withLocale('xx');
    expect(serverLocale()).toBe('xx');
    withLocale('pt-br');
    expect(serverLocale()).toBe('');
    withLocale('pt-BR');
    expect(serverLocale()).toBe('pt-BR');
    withLocale('en');
    expect(serverLocale()).toBe('en');
  });

  it('warns once and falls back to "" for a language with no files', () => {
    reloadLocales(root);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withLocale('fr');
    expect(serverLocale()).toBe('');
    expect(serverLocale()).toBe('');
    const aboutFr = warn.mock.calls.filter(([m]) => String(m).includes("'fr'"));
    expect(aboutFr).toHaveLength(1);
    expect(aboutFr[0][0]).toContain('available: en');
  });

  it('reads the folder on first use when resource start has not', () => {
    // No GetResourcePath outside FXServer: English only, and no crash.
    expect(locales().languages).toEqual(['en']);
  });
});
