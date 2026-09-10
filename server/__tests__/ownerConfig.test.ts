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
  parseDefaultContacts,
  parseDefaultDock,
  parseDisabledApps
} from '@mica/shared/ownerConfig';
import {
  MAX_DEFAULT_CONTACTS,
  NEVER_REFUSED_SERVICES,
  __resetOwnerConfig,
  defaultContacts,
  disabledAppFor,
  disabledApps,
  ownerConfig,
  resolveDefaultContacts
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
      defaultDock: ['phone', '', 'camera', '']
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
      places: 'places'
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
