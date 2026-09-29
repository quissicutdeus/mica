// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import {
  BUILT_IN_RINGTONE_IDS,
  FRAME_IDS,
  MAX_OWNER_SOUND_ID,
  MAX_SOUND_BYTES,
  MAX_SOUND_STEM,
  MAX_SOUNDS,
  MAX_WALLPAPERS,
  brandingPath,
  isOwnerSoundId,
  isRingtoneValue,
  parseBrandLogo,
  parseDefaultContacts,
  parseDefaultDock,
  parseDefaultFrame,
  parseDisabledApps,
  parseThemeSeed,
  parseWallpapersFolder
} from '@mica/shared/ownerConfig';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  MAX_DEFAULT_CONTACTS,
  NEVER_REFUSED_SERVICES,
  __resetOwnerConfig,
  defaultContacts,
  disabledAppFor,
  disabledApps,
  brandLogo,
  ownerConfig,
  resolveDefaultContacts,
  sounds,
  wallpapers
} from '../lib/ownerConfig';
// Loading every service is what fills the registry the classification check reads.
import '../services';
import { knownServices, registerService, serviceApps } from '../lib/services';

/**
 * What an owner configures without editing TypeScript (MICA-234): the three parsers in
 * `shared/`, the server's read of the convars, and which services a disabled app takes down.
 */

const withConvars = (values: Record<string, string>) => {
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name in values ? values[name] : fallback;
};

beforeEach(() => {
  __resetOwnerConfig();
  withConvars({});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).LoadResourceFile;
});

describe('parseDisabledApps', () => {
  it.each([[undefined], [null], [''], ['   '], [',, ,']])(
    'treats %j as nothing disabled',
    (raw) => {
      expect(parseDisabledApps(raw)).toEqual({ value: [], rejected: [] });
    }
  );

  it('trims, lowercases and de-duplicates app ids', () => {
    expect(parseDisabledApps(' mail, Notes ,,hodlr,MAIL')).toEqual({
      value: ['mail', 'notes', 'hodlr'],
      rejected: []
    });
  });

  it.each([
    ['Mail!', 'punctuation'],
    ['1app', 'a leading digit'],
    ['ext-app', 'a hyphen'],
    ['my app', 'a space'],
    ['settings', 'the app a player recovers from their own choices in'],
    ['SETTINGS', 'settings in any case']
  ])('refuses %s (%s) and names it verbatim', (entry) => {
    expect(parseDisabledApps(`mail,${entry}`)).toEqual({ value: ['mail'], rejected: [entry] });
  });

  it('reads a value that is not a string as its text rather than throwing', () => {
    expect(parseDisabledApps(42)).toEqual({ value: [], rejected: ['42'] });
  });
});

describe('parseDefaultDock', () => {
  it.each([[undefined], [''], ['  ']])('treats %j as the built-in dock', (raw) => {
    expect(parseDefaultDock(raw)).toEqual({ value: [], rejected: [] });
  });

  it('keeps positions, so an empty entry is an empty slot, and pads to four', () => {
    expect(parseDefaultDock('phone,,Camera')).toEqual({
      value: ['phone', '', 'camera', ''],
      rejected: []
    });
    expect(parseDefaultDock(',,,,')).toEqual({ value: ['', '', '', ''], rejected: [] });
  });

  it('refuses an id past the fourth slot', () => {
    expect(parseDefaultDock('a,b,c,d,e')).toEqual({ value: ['a', 'b', 'c', 'd'], rejected: ['e'] });
  });

  it('empties the slot of a malformed id or a repeat, and names both', () => {
    expect(parseDefaultDock('phone,Bad!,phone')).toEqual({
      value: ['phone', '', '', ''],
      rejected: ['Bad!', 'phone']
    });
  });
});

describe('parseDefaultContacts', () => {
  it.each([[undefined], [''], ['   ']])('treats %j as no contacts', (raw) => {
    expect(parseDefaultContacts(raw)).toEqual({ value: [], rejected: [] });
  });

  it.each([
    ['not json', 'text that is not JSON'],
    ['[{"name":', 'truncated JSON'],
    ['{"name":"Ada","number":"1"}', 'an object rather than an array'],
    ['"Ada"', 'a bare string']
  ])('refuses %s (%s) as a whole document', (raw) => {
    expect(parseDefaultContacts(raw)).toEqual({ value: [], rejected: [raw] });
  });

  it('trims each name and number', () => {
    expect(parseDefaultContacts('[{"name":" Ada ","number":" 555-0100 "}]')).toEqual({
      value: [{ name: 'Ada', number: '555-0100' }],
      rejected: []
    });
  });

  it('drops every entry missing a usable name or number, and keeps the rest', () => {
    const bad = [
      { name: 'No number' },
      { number: '555-0101' },
      { name: '', number: '555-0102' },
      { name: '   ', number: '555-0103' },
      { name: 'Numeric', number: 5550104 },
      { name: ['Ada'], number: '555-0105' },
      null,
      'Ada',
      []
    ];
    const raw = JSON.stringify([{ name: 'Kept', number: '555-0100' }, ...bad]);

    const parsed = parseDefaultContacts(raw);

    expect(parsed.value).toEqual([{ name: 'Kept', number: '555-0100' }]);
    expect(parsed.rejected).toEqual(bad.map((entry) => JSON.stringify(entry)));
  });
});

describe('resolving mica_default_contacts', () => {
  const FILE = '[{"name":"Dispatch","number":"911"}]';

  it('reads inline JSON without touching the resource', () => {
    const load = vi.fn();
    expect(resolveDefaultContacts(' [{"name":"Ada","number":"1"}] ', load)).toEqual({
      value: [{ name: 'Ada', number: '1' }],
      rejected: [],
      problem: null
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('reads anything else as a file inside this resource', () => {
    const load = vi.fn(() => FILE);
    expect(resolveDefaultContacts('data/contacts.json', load).value).toEqual([
      { name: 'Dispatch', number: '911' }
    ]);
    expect(load).toHaveBeenCalledWith('data/contacts.json');
  });

  it('accepts a Windows separator, since server.cfg is often written on Windows', () => {
    const load = vi.fn(() => FILE);
    resolveDefaultContacts('data\\contacts.json', load);
    expect(load).toHaveBeenCalledWith('data/contacts.json');
  });

  it.each([
    ['/etc/passwd', 'an absolute path'],
    ['\\\\host\\share\\c.json', 'a UNC path'],
    ['C:\\txData\\contacts.json', 'a drive path'],
    ['c:/contacts.json', 'a drive path with forward slashes'],
    ['../other/contacts.json', 'a parent directory'],
    ['data/../../contacts.json', 'a climb in the middle']
  ])('refuses %s (%s) before reading anything', (raw) => {
    const load = vi.fn(() => FILE);
    const resolved = resolveDefaultContacts(raw, load);
    expect(resolved.value).toEqual([]);
    expect(resolved.problem).toContain('not a path inside this resource');
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    ['null', () => null],
    ['undefined', () => undefined],
    ['an empty file', () => ''],
    [
      'a throw',
      () => {
        throw new Error('no such file');
      }
    ]
  ])('reports a file it cannot read (%s) as a problem, never a throw', (_label, load) => {
    const resolved = resolveDefaultContacts('data/missing.json', load);
    expect(resolved).toEqual({
      value: [],
      rejected: [],
      problem: "could not read 'data/missing.json' from this resource"
    });
  });

  it('reports a file that is not an array without reciting it', () => {
    const resolved = resolveDefaultContacts('data/c.json', () => '{"name":"x"}');
    expect(resolved.rejected).toEqual([]);
    expect(resolved.problem).toContain('is not a JSON array');
  });

  it('keeps the good entries of a file with bad ones', () => {
    const resolved = resolveDefaultContacts(
      'data/c.json',
      () => '[{"name":"Ada","number":"1"},{"name":"No number"}]'
    );
    expect(resolved.value).toEqual([{ name: 'Ada', number: '1' }]);
    expect(resolved.rejected).toEqual(['{"name":"No number"}']);
  });
});

describe('defaultContacts, as the server reads it', () => {
  const LIMITS = { name: 10, number: 5 };

  it('loads the file from this resource by name', () => {
    const load = vi.fn(() => '[{"name":"Ada","number":"911"}]');
    (globalThis as any).LoadResourceFile = load;
    withConvars({ mica_default_contacts: 'data/contacts.json' });

    expect(defaultContacts(LIMITS)).toEqual([{ name: 'Ada', number: '911' }]);
    expect(load).toHaveBeenCalledWith('mica', 'data/contacts.json');
  });

  it('reads the file once per value, not once per new phone', () => {
    const load = vi.fn(() => '[{"name":"Ada","number":"911"}]');
    (globalThis as any).LoadResourceFile = load;
    withConvars({ mica_default_contacts: 'data/contacts.json' });

    defaultContacts(LIMITS);
    defaultContacts(LIMITS);

    expect(load).toHaveBeenCalledOnce();
  });

  it('refuses an entry longer than its column, and says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withConvars({
      mica_default_contacts: JSON.stringify([
        { name: 'Ada', number: '911' },
        { name: 'A name far too long', number: '911' },
        { name: 'Bob', number: '555-0100' }
      ])
    });

    expect(defaultContacts(LIMITS)).toEqual([{ name: 'Ada', number: '911' }]);
    defaultContacts(LIMITS);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('[micaOS] mica_default_contacts');
    expect(warn.mock.calls[0][0]).toContain('A name far too long');
    expect(warn.mock.calls[0][0]).toContain('555-0100');
  });

  it('seeds at most the cap, the first that fit, and names the rest in the one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entries = Array.from({ length: MAX_DEFAULT_CONTACTS + 3 }, (_, i) => ({
      name: `C${i}`,
      number: `${i}`
    }));
    // A refused entry ahead of them does not use up a place.
    withConvars({
      mica_default_contacts: JSON.stringify([
        { name: 'A name far too long', number: '1' },
        ...entries
      ])
    });

    const value = defaultContacts(LIMITS);
    defaultContacts(LIMITS);

    expect(MAX_DEFAULT_CONTACTS).toBe(50);
    expect(value).toEqual(entries.slice(0, MAX_DEFAULT_CONTACTS));
    expect(warn).toHaveBeenCalledOnce();
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain(`at most ${MAX_DEFAULT_CONTACTS} of them`);
    expect(message).toContain('A name far too long');
    for (let i = MAX_DEFAULT_CONTACTS; i < MAX_DEFAULT_CONTACTS + 3; i++) {
      expect(message).toContain(`"name":"C${i}"`);
    }
    expect(message).not.toContain(`"name":"C${MAX_DEFAULT_CONTACTS - 1}"`);
  });

  it('warns about a missing file and answers no contacts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis as any).LoadResourceFile = () => null;
    withConvars({ mica_default_contacts: 'data/missing.json' });

    expect(defaultContacts(LIMITS)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not read 'data/missing.json'")
    );
  });
});

describe('the disabled list and the dock, as the server reads them', () => {
  it('names every refused entry in one warning, once per value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withConvars({ mica_disabled_apps: 'mail,settings,Bad!' });

    expect(disabledApps()).toEqual(['mail']);
    disabledApps();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('[micaOS] mica_disabled_apps');
    expect(warn.mock.calls[0][0]).toContain("'settings'");
    expect(warn.mock.calls[0][0]).toContain("'Bad!'");

    // A new value is a new mistake, and is told again.
    withConvars({ mica_disabled_apps: 'Worse!' });
    disabledApps();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('stays quiet for a value with nothing refused', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withConvars({ mica_disabled_apps: 'mail', mica_default_dock: 'phone,messages' });
    ownerConfig();
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers both halves of shell:ownerConfig', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    withConvars({ mica_disabled_apps: 'hodlr, snek', mica_default_dock: 'phone,,camera,,music' });

    expect(ownerConfig()).toEqual({
      disabledApps: ['hodlr', 'snek'],
      defaultDock: ['phone', '', 'camera', ''],
      themeSeed: null,
      defaultFrame: 'classic',
      wallpapers: [],
      brandLogo: null,
      sounds: []
    });
  });
});

describe('which services a disabled app takes down', () => {
  it('holds every registered service to declaring an app or being listed, never both', () => {
    const services = knownServices();
    expect(services.length, 'services did not load').toBeGreaterThan(20);

    const declared = new Set(serviceApps().keys());
    const never = new Set(NEVER_REFUSED_SERVICES);
    expect(declared.size, 'no service declared an app').toBeGreaterThan(5);

    const unclassified = services.filter((id) => !declared.has(id) && !never.has(id));
    const both = services.filter((id) => declared.has(id) && never.has(id));
    const stale = [...never].filter((id) => !services.includes(id));

    expect(
      unclassified,
      "declare this service's `app`, or list it in NEVER_REFUSED_SERVICES — lib/ownerConfig.ts"
    ).toEqual([]);
    expect(both).toEqual([]);
    expect(stale, 'a listed service nothing registers is a typo').toEqual([]);
  });

  it('declares only apps that exist, and never Settings', () => {
    const appsDir = join(__dirname, '..', '..', 'web', 'src', 'apps');
    const apps = readdirSync(appsDir).filter((entry) =>
      statSync(join(appsDir, entry)).isDirectory()
    );

    for (const app of serviceApps().values()) {
      expect(apps, `${app} is not an app`).toContain(app);
      expect(app).not.toBe('settings');
    }
  });

  it("reads each service's app from its own declaration, under another name too", () => {
    withConvars({ mica_disabled_apps: 'blabber,bank,snek' });
    expect(disabledAppFor('blabber_dms')).toBe('blabber');
    // Shared with social add-ons outside this repo, so Blabber being off does not refuse it.
    expect(disabledAppFor('accounts')).toBeNull();
    expect(disabledAppFor('invoices')).toBe('bank');
    expect(disabledAppFor('highscores')).toBe('snek');
  });

  it('names the refused service-to-app pairs exactly', () => {
    expect(Object.fromEntries([...serviceApps()].sort(([a], [b]) => a.localeCompare(b)))).toEqual({
      blabber: 'blabber',
      blabber_dms: 'blabber',
      highscores: 'snek',
      hodlr: 'hodlr',
      invoices: 'bank',
      jobs: 'jobs',
      mail: 'mail',
      marketplace: 'marketplace',
      notes: 'notes',
      places: 'places',
      store: 'store'
    });
  });

  it('refuses a second declaration naming a different app', () => {
    expect(() => registerService('highscores', 'snek')).not.toThrow();
    expect(() => registerService('highscores', 'notes')).toThrow(/already declared as 'snek'/);
    expect(disabledAppFor('highscores')).toBeNull();
    withConvars({ mica_disabled_apps: 'snek' });
    expect(disabledAppFor('highscores')).toBe('snek');
  });

  it('never refuses the phone itself or a shared service, even when the list names it', () => {
    withConvars({ mica_disabled_apps: NEVER_REFUSED_SERVICES.join(',') });
    for (const service of NEVER_REFUSED_SERVICES) {
      expect(disabledAppFor(service), service).toBeNull();
    }
  });

  it('does not read the convar for a service no app owns', () => {
    const read = vi.fn((_name: string, fallback: string) => fallback);
    (globalThis as any).GetConvar = read;
    disabledAppFor('contacts');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('branding convars, parsed (MICA-236)', () => {
  it('takes a #rrggbb seed, lowercased, and refuses anything else', () => {
    expect(parseThemeSeed(' #1A73E8 ')).toEqual({ value: '#1a73e8', rejected: [] });
    expect(parseThemeSeed('')).toEqual({ value: null, rejected: [] });
    for (const bad of ['1a73e8', '#1a73e', '#1a73e8ff', 'blue', '#gggggg']) {
      expect(parseThemeSeed(bad)).toEqual({ value: null, rejected: [bad] });
    }
  });

  it('takes one of the frame ids, any case, and falls back to classic', () => {
    expect(FRAME_IDS).toEqual(['classic', 'notch', 'punch']);
    expect(parseDefaultFrame('Notch')).toEqual({ value: 'notch', rejected: [] });
    expect(parseDefaultFrame('')).toEqual({ value: 'classic', rejected: [] });
    expect(parseDefaultFrame('dynamic-island')).toEqual({
      value: 'classic',
      rejected: ['dynamic-island']
    });
  });

  it.each([
    ['../server.cfg', 'a parent'],
    ['branding/../server.cfg', 'a climb out of branding'],
    ['branding/./x', 'a dot segment'],
    ['branding\\wallpapers', 'a backslash'],
    ['/branding/wallpapers', 'an absolute path'],
    ['C:/branding', 'a drive'],
    ['https://evil.example/x', 'a URL'],
    ['wallpapers', 'a folder outside branding'],
    ['branding//x', 'an empty segment'],
    ['branding/my wallpapers', 'a space'],
    ['branding/.hidden', 'a hidden segment']
  ])('refuses %s (%s) as a branding path', (raw) => {
    expect(brandingPath(raw)).toBeNull();
    expect(parseWallpapersFolder(raw)).toEqual({ value: 'branding/wallpapers', rejected: [raw] });
  });

  it('accepts a folder under branding/, dropping a trailing slash', () => {
    expect(parseWallpapersFolder('branding/city/')).toEqual({
      value: 'branding/city',
      rejected: []
    });
    expect(parseWallpapersFolder('')).toEqual({ value: 'branding/wallpapers', rejected: [] });
  });

  it('takes a logo file under branding/ with an image extension, and nothing else', () => {
    expect(parseBrandLogo('branding/logo.SVG')).toEqual({
      value: 'branding/logo.SVG',
      rejected: []
    });
    expect(parseBrandLogo('')).toEqual({ value: null, rejected: [] });
    for (const bad of ['branding/logo.gif', 'branding', 'logo.png', 'branding/../logo.png']) {
      expect(parseBrandLogo(bad)).toEqual({ value: null, rejected: [bad] });
    }
  });
});

describe('branding, read by the server (MICA-236)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mica-branding-'));
    (globalThis as any).GetResourcePath = () => root;
    (globalThis as any).GetCurrentResourceName = () => 'mica';
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete (globalThis as any).GetResourcePath;
    vi.restoreAllMocks();
  });

  const touch = (path: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'x');
  };

  it('lists the wallpaper folder as cfx-nui URLs, images only, sorted by name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const f of [
      'b.jpg',
      'a.PNG',
      'c.webp',
      'notes.txt',
      'd.gif',
      'bad name.png',
      '.hidden.png'
    ]) {
      touch(`branding/wallpapers/${f}`);
    }
    mkdirSync(join(root, 'branding/wallpapers/sub.png'));

    expect(wallpapers()).toEqual([
      'https://cfx-nui-mica/branding/wallpapers/a.PNG',
      'https://cfx-nui-mica/branding/wallpapers/b.jpg',
      'https://cfx-nui-mica/branding/wallpapers/c.webp'
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'bad name.png'"));
    expect(warn.mock.calls.some(([m]) => String(m).includes('notes.txt'))).toBe(false);
  });

  it('lists the folder once and keeps it', () => {
    touch('branding/wallpapers/a.png');
    expect(wallpapers()).toHaveLength(1);
    touch('branding/wallpapers/b.png');
    expect(wallpapers()).toHaveLength(1);
  });

  it('reads the folder the convar names', () => {
    touch('branding/city/night.jpg');
    withConvars({ mica_wallpapers: 'branding/city' });
    expect(wallpapers()).toEqual(['https://cfx-nui-mica/branding/city/night.jpg']);
  });

  it('caps the list and names what it left out', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < MAX_WALLPAPERS + 3; i++) {
      touch(`branding/wallpapers/w${String(i).padStart(3, '0')}.png`);
    }
    const urls = wallpapers();
    expect(urls).toHaveLength(MAX_WALLPAPERS);
    expect(urls.at(-1)).toContain(`w${String(MAX_WALLPAPERS - 1).padStart(3, '0')}.png`);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('w050.png, w051.png, w052.png'));
  });

  it('is [] with nothing said when the folder is not there', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(wallpapers()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers the logo as a URL when the file exists', () => {
    touch('branding/logo.svg');
    withConvars({ mica_brand_logo: 'branding/logo.svg' });
    expect(brandLogo()).toBe('https://cfx-nui-mica/branding/logo.svg');
  });

  it('warns once and answers null for a logo path with no file behind it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withConvars({ mica_brand_logo: 'branding/missing.png' });
    expect(brandLogo()).toBeNull();
    expect(brandLogo()).toBeNull();
    const about = warn.mock.calls.filter(([m]) => String(m).includes('branding/missing.png'));
    expect(about).toHaveLength(1);
  });

  it('names every refused branding value in one warning each, once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withConvars({
      mica_theme_seed: 'blue',
      mica_default_frame: 'round',
      mica_wallpapers: '../outside',
      mica_brand_logo: 'C:/logo.png'
    });

    const config = ownerConfig();
    ownerConfig();

    expect(config).toMatchObject({
      themeSeed: null,
      defaultFrame: 'classic',
      wallpapers: [],
      brandLogo: null,
      sounds: []
    });
    const said = warn.mock.calls.map(([m]) => String(m));
    for (const [convar, value] of [
      ['mica_theme_seed', 'blue'],
      ['mica_default_frame', 'round'],
      ['mica_wallpapers', '../outside'],
      ['mica_brand_logo', 'C:/logo.png']
    ]) {
      expect(said.filter((m) => m.includes(convar) && m.includes(`'${value}'`))).toHaveLength(1);
    }
  });

  it('carries all four over shell:ownerConfig', () => {
    touch('branding/wallpapers/a.png');
    touch('branding/logo.png');
    withConvars({
      mica_theme_seed: '#FF8800',
      mica_default_frame: 'punch',
      mica_brand_logo: 'branding/logo.png'
    });
    expect(ownerConfig()).toMatchObject({
      themeSeed: '#ff8800',
      defaultFrame: 'punch',
      wallpapers: ['https://cfx-nui-mica/branding/wallpapers/a.png'],
      brandLogo: 'https://cfx-nui-mica/branding/logo.png'
    });
  });
});

describe('owner sounds, read by the server (MICA-256)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mica-sounds-'));
    (globalThis as any).GetResourcePath = () => root;
    (globalThis as any).GetCurrentResourceName = () => 'mica';
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete (globalThis as any).GetResourcePath;
    vi.restoreAllMocks();
  });

  const sound = (name: string, bytes = 1): void => {
    mkdirSync(join(root, 'branding/sounds'), { recursive: true });
    writeFileSync(join(root, 'branding/sounds', name), Buffer.alloc(bytes));
  };
  const warnings = (warn: { mock: { calls: unknown[][] } }): string[] =>
    warn.mock.calls.map(([m]) => String(m));

  it('lists the folder sorted by file name, with an owner: id and a readable label', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const f of ['z.wav', 'old_phone-ring.mp3', 'Bell.OGG', 'a.oga', 'b.opus']) sound(f);

    expect(sounds()).toEqual([
      { id: 'owner:Bell', label: 'Bell', url: 'https://cfx-nui-mica/branding/sounds/Bell.OGG' },
      { id: 'owner:a', label: 'a', url: 'https://cfx-nui-mica/branding/sounds/a.oga' },
      { id: 'owner:b', label: 'b', url: 'https://cfx-nui-mica/branding/sounds/b.opus' },
      {
        id: 'owner:old_phone-ring',
        label: 'old phone ring',
        url: 'https://cfx-nui-mica/branding/sounds/old_phone-ring.mp3'
      },
      { id: 'owner:z', label: 'z', url: 'https://cfx-nui-mica/branding/sounds/z.wav' }
    ]);
  });

  it('skips a bad extension, an unsafe name, a folder and a repeated stem, one warning each', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const f of ['ring.ogg', 'ring.wav', 'song.m4a', 'notes.txt', 'my ring.ogg']) sound(f);
    mkdirSync(join(root, 'branding/sounds/sub.ogg'));
    sound('.gitkeep');

    expect(sounds().map((s) => s.id)).toEqual(['owner:ring']);
    sounds();
    const said = warnings(warn);
    for (const name of ['ring.wav', 'song.m4a', 'notes.txt', 'my ring.ogg', 'sub.ogg']) {
      expect(said.filter((m) => m.includes(`branding/sounds/${name}'`))).toHaveLength(1);
    }
    expect(said.some((m) => m.includes('.gitkeep'))).toBe(false);
    expect(said).toHaveLength(5);
  });

  it('skips a file over the size cap and names it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sound('small.ogg', MAX_SOUND_BYTES);
    sound('huge.ogg', MAX_SOUND_BYTES + 1);

    expect(sounds().map((s) => s.id)).toEqual(['owner:small']);
    expect(warnings(warn)).toEqual([expect.stringContaining("'branding/sounds/huge.ogg'")]);
  });

  it('holds the stem to MAX_SOUND_STEM so owner:<stem> fits where it is stored', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fits = 'a'.repeat(MAX_SOUND_STEM);
    const over = 'b'.repeat(MAX_SOUND_STEM + 1);
    sound(`${fits}.ogg`);
    sound(`${over}.ogg`);

    const ids = sounds().map((s) => s.id);
    expect(ids).toEqual([`owner:${fits}`]);
    expect(ids[0].length).toBeLessThanOrEqual(54);
    expect(warnings(warn)).toEqual([expect.stringContaining(`${over}.ogg`)]);
  });

  it('caps the list and names what it left out', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < MAX_SOUNDS + 2; i++) sound(`s${String(i).padStart(2, '0')}.ogg`);

    const listed = sounds();
    expect(listed).toHaveLength(MAX_SOUNDS);
    expect(listed.at(-1)?.id).toBe(`owner:s${MAX_SOUNDS - 1}`);
    expect(warnings(warn)).toEqual([expect.stringContaining('s30.ogg, s31.ogg')]);
  });

  it('is [] with nothing said when the folder is not there', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(sounds()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('lists once and keeps it, and rides along on shell:ownerConfig', () => {
    sound('a.ogg');
    expect(sounds()).toHaveLength(1);
    sound('b.ogg');
    expect(ownerConfig().sounds.map((s) => s.id)).toEqual(['owner:a']);
  });
});

describe('ringtone values (MICA-256)', () => {
  it('accepts the built-ins and owner ids in the listed shape', () => {
    for (const id of BUILT_IN_RINGTONE_IDS) expect(isRingtoneValue(id)).toBe(true);
    for (const id of ['owner:a', 'owner:Bell', 'owner:old_phone-ring', 'owner:v1.2']) {
      expect(isOwnerSoundId(id)).toBe(true);
      expect(isRingtoneValue(id)).toBe(true);
    }
    expect(isRingtoneValue(`owner:${'a'.repeat(MAX_SOUND_STEM)}`)).toBe(true);
    expect(MAX_OWNER_SOUND_ID).toBe('owner:'.length + MAX_SOUND_STEM);
  });

  it.each([
    'airhorn',
    'Classic',
    '',
    'owner:',
    'owner:.gitkeep',
    'owner:a b',
    'owner:a/b',
    'owner:a\\b',
    'owner:é',
    ' owner:a',
    'owner:a\n',
    `owner:${'a'.repeat(MAX_SOUND_STEM + 1)}`
  ])('refuses %j', (value) => {
    expect(isRingtoneValue(value)).toBe(false);
  });

  it('refuses a non-string', () => {
    for (const value of [null, undefined, 1, {}, ['classic']]) {
      expect(isRingtoneValue(value)).toBe(false);
    }
  });
});
