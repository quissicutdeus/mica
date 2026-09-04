// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseRemoteAppConfig } from '@mica/shared/nui';

/**
 * `mica_addon_hosts` and `mica_addon_catalog` — the two values that decide whether the
 * Store can install anything at all (MICA-126).
 *
 * The case that has to hold above every other is the **unset** one. Everything in the
 * remote add-on path is gated on the allowlist, so a bug that filled it with a stray empty
 * string, or that read a default host from somewhere, would silently opt every server on
 * earth into fetching and running third-party JavaScript. The first test here is that one.
 *
 * Manual FiveM stubs, following `CameraQuality.test.ts`: the module registers a NUI
 * callback at import time, so the globals have to exist before it does.
 */
let convars: Record<string, string>;
let nuiCallbacks: string[];
let warnings: string[];

const installGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  g.GetConvar = (name: string, fallback: string) => convars[name] ?? fallback;
  g.RegisterNuiCallbackType = (name: string) => nuiCallbacks.push(name);
  g.on = () => undefined;
  g.onNet = () => undefined;
};

const load = async () => {
  vi.resetModules();
  return import('../services/RemoteApps');
};

beforeEach(() => {
  convars = {};
  nuiCallbacks = [];
  warnings = [];
  installGlobals();
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
});

describe('remoteAppConfig', () => {
  it('is empty on a server that has configured neither convar', async () => {
    const { remoteAppConfig } = await load();
    expect(remoteAppConfig()).toEqual({ hosts: [], catalogUrl: '' });
  });

  it('registers the NUI callback the shell asks on', async () => {
    await load();
    expect(nuiCallbacks).toContain('remoteAppConfig');
  });

  it('reads both convars when an operator sets them', async () => {
    convars.mica_addon_hosts = 'store.example.com';
    convars.mica_addon_catalog = 'https://store.example.com/catalog.json';
    const { remoteAppConfig } = await load();
    expect(remoteAppConfig()).toEqual({
      hosts: ['store.example.com'],
      catalogUrl: 'https://store.example.com/catalog.json'
    });
  });

  it('warns when the catalog host is missing from the allowlist', async () => {
    // The evening-costing mistake: set the catalog, forget the allowlist. `fetchCatalog`
    // holds the catalog URL to the same allowlist as every bundle, so this configuration
    // lists nothing and explains itself only in a console nobody opens.
    convars.mica_addon_catalog = 'https://store.example.com/catalog.json';
    const { catalogWarning, remoteAppConfig } = await load();
    expect(catalogWarning(remoteAppConfig())).toMatch(/mica_addon_hosts/);
    expect(warnings.join('\n')).toMatch(/mica_addon_hosts/);
  });

  it('warns about a catalog URL that is not https', async () => {
    convars.mica_addon_hosts = 'store.example.com';
    convars.mica_addon_catalog = 'http://store.example.com/catalog.json';
    const { catalogWarning, remoteAppConfig } = await load();
    expect(catalogWarning(remoteAppConfig())).toMatch(/https/);
  });

  it('says nothing when the two agree', async () => {
    convars.mica_addon_hosts = 'store.example.com';
    convars.mica_addon_catalog = 'https://store.example.com/catalog.json';
    const { catalogWarning, remoteAppConfig } = await load();
    expect(catalogWarning(remoteAppConfig())).toBeNull();
    expect(warnings).toEqual([]);
  });
});

describe('parseTrustedHosts', () => {
  it('accepts commas, whitespace, or both', async () => {
    const { parseTrustedHosts } = await load();
    expect(parseTrustedHosts('a.example.com, b.example.com   c.example.com')).toEqual([
      'a.example.com',
      'b.example.com',
      'c.example.com'
    ]);
  });

  it('yields nothing for an empty or whitespace-only convar', async () => {
    const { parseTrustedHosts } = await load();
    expect(parseTrustedHosts('')).toEqual([]);
    expect(parseTrustedHosts('   ,  , ')).toEqual([]);
  });

  it('reduces a pasted URL to its hostname', async () => {
    // The value an operator has in front of them while writing this line is their catalog
    // URL, so pasting it is the obvious mistake — and an allowlist entry that can never
    // match a hostname fails invisibly.
    const { parseTrustedHosts } = await load();
    expect(parseTrustedHosts('https://store.example.com:8443/catalog.json')).toEqual([
      'store.example.com'
    ]);
  });

  it('lowercases and de-duplicates, because the comparison does', async () => {
    const { parseTrustedHosts } = await load();
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
