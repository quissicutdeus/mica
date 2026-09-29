// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseRemoteAppConfig } from '@mica/shared/nui';
import {
  PUBLIC_ADDON_HOST,
  parseTrustedHosts,
  publicAddonCatalogUrl
} from '@mica/shared/addonConfig';
import { SDK_CONTRACT_VERSION } from '../../sdk/version';

/**
 * `mica_addon_hosts` and `mica_addon_catalog` — where the Store finds add-ons and whose
 * code it may run (MICA-126, MICA-237).
 *
 * Three states, told apart by whether the catalog convar was ever set: never set is the
 * project's public catalog with its host allowed; set to a URL is the operator's own, with
 * exactly the hosts they listed; set to `off` or to empty is nothing at all. The case that
 * has to hold above the others is **off**: an operator who opted out must not be opted back
 * in by a stray host or a spelling of `off` this file did not expect.
 *
 * Manual FiveM stubs, following `CameraQuality.test.ts`: the module registers a NUI
 * callback at import time, so the globals have to exist before it does. `GetConvar`
 * answers its caller's default for a convar the test did not set, which is how the real
 * one tells "never set" from "set to empty".
 */
let convars: Record<string, string>;
let nuiCallbacks: string[];
let handlers: Record<string, (data: unknown, cb: (reply: unknown) => void) => void>;
let warnings: string[];
let logs: string[];

const DEFAULT_URL = publicAddonCatalogUrl(SDK_CONTRACT_VERSION);

const installGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  g.GetConvar = (name: string, fallback: string) => convars[name] ?? fallback;
  g.RegisterNuiCallbackType = (name: string) => nuiCallbacks.push(name);
  g.on = (name: string, handler: (data: unknown, cb: (reply: unknown) => void) => void) => {
    handlers[name] = handler;
  };
  g.onNet = () => undefined;
};

const load = async () => {
  vi.resetModules();
  return import('../services/RemoteApps');
};

beforeEach(() => {
  convars = {};
  nuiCallbacks = [];
  handlers = {};
  warnings = [];
  logs = [];
  installGlobals();
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});

describe('default: mica_addon_catalog never set', () => {
  it('points at the public catalog for this SDK contract, with its host allowed', async () => {
    const { addonSetting, remoteAppConfig } = await load();
    expect(DEFAULT_URL).toBe(
      `https://${PUBLIC_ADDON_HOST}/addons/sdk-${SDK_CONTRACT_VERSION}/catalog.json`
    );
    expect(addonSetting().state).toBe('default');
    expect(remoteAppConfig()).toEqual({ hosts: [PUBLIC_ADDON_HOST], catalogUrl: DEFAULT_URL });
  });

  it('puts the public host first and keeps every host the operator listed', async () => {
    convars.mica_addon_hosts = 'cdn.example.com, Store.Example.com';
    const { remoteAppConfig } = await load();
    expect(remoteAppConfig()).toEqual({
      hosts: [PUBLIC_ADDON_HOST, 'cdn.example.com', 'store.example.com'],
      catalogUrl: DEFAULT_URL
    });
  });

  it('does not list the public host twice when the operator already did', async () => {
    convars.mica_addon_hosts = `cdn.example.com ${PUBLIC_ADDON_HOST}`;
    const { remoteAppConfig } = await load();
    expect(remoteAppConfig().hosts).toEqual(['cdn.example.com', PUBLIC_ADDON_HOST]);
  });

  it('treats a whitespace-only host list as listing nothing', async () => {
    convars.mica_addon_hosts = '   ,  , ';
    const { remoteAppConfig } = await load();
    expect(remoteAppConfig().hosts).toEqual([PUBLIC_ADDON_HOST]);
  });

  it('says which catalog is in force at start, and warns about nothing', async () => {
    await load();
    expect(logs).toEqual([`[micaOS] add-on catalog (mica_addon_catalog) default: ${DEFAULT_URL}`]);
    expect(warnings).toEqual([]);
  });
});

describe('custom: mica_addon_catalog set to a URL', () => {
  it('uses that catalog and exactly the listed hosts, without the public one', async () => {
    convars.mica_addon_hosts = 'store.example.com';
    convars.mica_addon_catalog = 'https://store.example.com/catalog.json';
    const { addonSetting, remoteAppConfig, catalogWarning } = await load();
    expect(addonSetting().state).toBe('custom');
    expect(remoteAppConfig()).toEqual({
      hosts: ['store.example.com'],
      catalogUrl: 'https://store.example.com/catalog.json'
    });
    expect(catalogWarning(addonSetting())).toBeNull();
    expect(warnings).toEqual([]);
    expect(logs).toEqual([
      '[micaOS] add-on catalog (mica_addon_catalog) custom: https://store.example.com/catalog.json'
    ]);
  });

  it('trims whitespace around the URL', async () => {
    convars.mica_addon_hosts = 'store.example.com';
    convars.mica_addon_catalog = '  https://store.example.com/catalog.json \t';
    const { remoteAppConfig } = await load();
    expect(remoteAppConfig().catalogUrl).toBe('https://store.example.com/catalog.json');
  });

  it('warns when the catalog host is missing from the allowlist', async () => {
    // The evening-costing mistake: set the catalog, forget the allowlist. `fetchCatalog`
    // holds the catalog URL to the same allowlist as every bundle, so this configuration
    // lists nothing and explains itself only in a console nobody opens. The public host is
    // not added to rescue it: a custom catalog gets exactly the hosts the operator listed.
    convars.mica_addon_catalog = 'https://store.example.com/catalog.json';
    const { addonSetting, catalogWarning, remoteAppConfig } = await load();
    expect(remoteAppConfig().hosts).toEqual([]);
    expect(catalogWarning(addonSetting())).toMatch(/mica_addon_hosts/);
    expect(warnings.join('\n')).toMatch(/mica_addon_hosts/);
  });

  it('warns about a catalog URL that is not https', async () => {
    convars.mica_addon_hosts = 'store.example.com';
    convars.mica_addon_catalog = 'http://store.example.com/catalog.json';
    const { addonSetting, catalogWarning } = await load();
    expect(catalogWarning(addonSetting())).toMatch(/https/);
  });

  it('warns about a catalog URL with no hostname', async () => {
    convars.mica_addon_catalog = 'https:///catalog.json';
    const { addonSetting, catalogWarning } = await load();
    expect(catalogWarning(addonSetting())).toMatch(/no hostname/);
  });
});

describe('off: mica_addon_catalog set to off, or to empty', () => {
  it.each(['off', 'OFF', ' Off ', '', '   ', '\t'])(
    'answers no catalog and no hosts for %j, whatever hosts are listed',
    async (value) => {
      convars.mica_addon_catalog = value;
      convars.mica_addon_hosts = `store.example.com ${PUBLIC_ADDON_HOST}`;
      const { addonSetting, remoteAppConfig } = await load();
      expect(addonSetting().state).toBe('off');
      expect(remoteAppConfig()).toEqual({ hosts: [], catalogUrl: '' });
    }
  );

  it('says it is off at start, and warns about nothing', async () => {
    convars.mica_addon_catalog = 'off';
    await load();
    expect(logs).toEqual(['[micaOS] add-on catalog (mica_addon_catalog) off']);
    expect(warnings).toEqual([]);
  });

  it('is off, not the default, where the runtime has no GetConvar at all', async () => {
    // A runtime that cannot say what the operator configured must not assume they wanted
    // the public catalog.
    delete (globalThis as Record<string, unknown>).GetConvar;
    const { remoteAppConfig } = await load();
    expect(remoteAppConfig()).toEqual({ hosts: [], catalogUrl: '' });
  });
});

describe('the NUI callback', () => {
  it('is registered under the name the shell asks on', async () => {
    await load();
    expect(nuiCallbacks).toContain('remoteAppConfig');
  });

  it('answers the payload the shell parses, and nothing beyond it', async () => {
    // `state` is for the operator's console line, not for the phone: the shell's
    // `parseRemoteAppConfig` reads two fields and this answers exactly those two.
    await load();
    const replies: unknown[] = [];
    handlers['__cfx_nui:remoteAppConfig']({}, (reply) => replies.push(reply));
    expect(replies).toEqual([{ hosts: [PUBLIC_ADDON_HOST], catalogUrl: DEFAULT_URL }]);
    expect(parseRemoteAppConfig(replies[0])).toEqual(replies[0]);
  });

  it('re-reads the convars on every call, so a live setr reaches the next boot', async () => {
    await load();
    convars.mica_addon_catalog = 'off';
    const replies: unknown[] = [];
    handlers['__cfx_nui:remoteAppConfig']({}, (reply) => replies.push(reply));
    expect(replies).toEqual([{ hosts: [], catalogUrl: '' }]);
  });
});

describe('parseTrustedHosts', () => {
  it('accepts commas, whitespace, or both', () => {
    expect(parseTrustedHosts('a.example.com, b.example.com   c.example.com')).toEqual([
      'a.example.com',
      'b.example.com',
      'c.example.com'
    ]);
  });

  it('yields nothing for an empty or whitespace-only convar', () => {
    expect(parseTrustedHosts('')).toEqual([]);
    expect(parseTrustedHosts('   ,  , ')).toEqual([]);
  });

  it('reduces a pasted URL to its hostname', () => {
    // The value an operator has in front of them while writing this line is their catalog
    // URL, so pasting it is the obvious mistake — and an allowlist entry that can never
    // match a hostname fails invisibly.
    expect(parseTrustedHosts('https://store.example.com:8443/catalog.json')).toEqual([
      'store.example.com'
    ]);
  });

  it('lowercases and de-duplicates, because the comparison does', () => {
    expect(parseTrustedHosts('Store.Example.COM, store.example.com')).toEqual([
      'store.example.com'
    ]);
  });
});

describe('parseRemoteAppConfig', () => {
  it('answers the empty config for a reply that is not one', () => {
    expect(parseRemoteAppConfig(null)).toBeNull();
    expect(parseRemoteAppConfig('nope')).toBeNull();
    expect(parseRemoteAppConfig([])).toBeNull();
  });

  it('treats a missing or empty field as configured-nothing rather than a failure', () => {
    expect(parseRemoteAppConfig({})).toEqual({ hosts: [], catalogUrl: '' });
  });

  it('drops a host that is not a usable string instead of coercing it', () => {
    // This list decides who may ship JavaScript into a player's phone. `String(null)` is
    // not a host, and neither is an object that stringifies to something host-shaped.
    expect(
      parseRemoteAppConfig({ hosts: ['ok.example.com', null, 42, '', { toString: () => 'x' }] })
    ).toEqual({ hosts: ['ok.example.com'], catalogUrl: '' });
  });

  it('lowercases and de-duplicates on the receiving side too', () => {
    expect(parseRemoteAppConfig({ hosts: ['A.example.com', 'a.example.com'] })).toEqual({
      hosts: ['a.example.com'],
      catalogUrl: ''
    });
  });
});
