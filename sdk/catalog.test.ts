// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setTrustedRemoteAppHosts } from './remoteAppSecurity';
import { fetchCatalog, isCatalogEntry, type CatalogEntry } from './catalog';

const validEntry: CatalogEntry = {
  id: 'remote_widget',
  name: 'Widget',
  version: '1.0.0',
  description: 'A remote widget app.',
  bundleUrl: 'https://store.example.com/apps/widget.js',
  sha256: 'a'.repeat(64),
  color: 'bg-sky-500',
  permissions: []
};

const jsonResponse = (body: unknown, ok = true, status = 200): Response =>
  ({
    ok,
    status,
    json: () => Promise.resolve(body)
  }) as Response;

describe('fetchCatalog', () => {
  beforeEach(() => {
    setTrustedRemoteAppHosts(['store.example.com']);
    vi.restoreAllMocks();
  });

  it('refuses a catalog URL that is not on the trusted host allowlist', async () => {
    await expect(fetchCatalog('https://evil.example.com/catalog.json')).rejects.toThrow(
      "'https://evil.example.com/catalog.json' is not on the trusted host allowlist"
    );
  });

  it('returns every well-formed entry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([validEntry]));

    const entries = await fetchCatalog('https://store.example.com/catalog.json');

    expect(entries).toEqual([validEntry]);
  });

  it('drops a malformed entry and keeps the rest of the catalog', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([validEntry, { id: 'broken' /* missing every other field */ }])
    );

    const entries = await fetchCatalog('https://store.example.com/catalog.json');

    expect(entries).toEqual([validEntry]);
    expect(warn).toHaveBeenCalled();
  });

  it('throws on a non-array reply', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ not: 'an array' }));

    await expect(fetchCatalog('https://store.example.com/catalog.json')).rejects.toThrow(
      'did not return a JSON array'
    );
  });

  it('throws on a non-ok HTTP response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([], false, 503));

    await expect(fetchCatalog('https://store.example.com/catalog.json')).rejects.toThrow(
      'HTTP 503'
    );
  });
});

describe('isCatalogEntry', () => {
  it('accepts a well-formed entry, permissions included', () => {
    expect(isCatalogEntry(validEntry)).toBe(true);
  });

  it('accepts requiresNetwork as an optional boolean', () => {
    expect(isCatalogEntry({ ...validEntry, requiresNetwork: true })).toBe(true);
    expect(isCatalogEntry({ ...validEntry, requiresNetwork: 'yes' })).toBe(false);
  });

  it('accepts requires as an optional array drawn from the capability vocabulary', () => {
    expect(isCatalogEntry({ ...validEntry, requires: ['money'] })).toBe(true);
    expect(isCatalogEntry({ ...validEntry, requires: [] })).toBe(true);
    // Absent is what every catalog written before this field existed says, and it means
    // "needs none" rather than "unknown".
    expect(isCatalogEntry(validEntry)).toBe(true);
  });

  it('rejects a requires naming a capability no server could ever satisfy', () => {
    // Same reasoning as `defineApp` throwing on one: an unknown name is never satisfied, so
    // the row would list an app refused everywhere with nothing said about why.
    expect(isCatalogEntry({ ...validEntry, requires: ['teleportation'] })).toBe(false);
    expect(isCatalogEntry({ ...validEntry, requires: 'money' })).toBe(false);
  });

  it('accepts networkHosts as an optional array of strings (MICA-24)', () => {
    expect(isCatalogEntry({ ...validEntry, networkHosts: ['https://api.example.com'] })).toBe(true);
    expect(isCatalogEntry({ ...validEntry, networkHosts: [] })).toBe(true);
    expect(isCatalogEntry({ ...validEntry, networkHosts: 'https://api.example.com' })).toBe(false);
    expect(isCatalogEntry({ ...validEntry, networkHosts: [123] })).toBe(false);
  });

  /**
   * Shape only, deliberately. Whether these ids are ones this app may own is `defineApp`'s
   * question (its own namespace) and the registry's (a collision with something already
   * installed), and neither answer is available from a row on its own — dropping a row here
   * for a claim the registry would refuse anyway would only hide the reason from the player.
   */
  it('accepts services as an optional array of strings (MICA-196)', () => {
    expect(isCatalogEntry({ ...validEntry, services: ['tester', 'tester_extra'] })).toBe(true);
    expect(isCatalogEntry({ ...validEntry, services: [] })).toBe(true);
    expect(isCatalogEntry({ ...validEntry, services: 'tester' })).toBe(false);
    expect(isCatalogEntry({ ...validEntry, services: [123] })).toBe(false);
  });

  it('accepts sdkContract as an optional string, whatever it says (MICA-196)', () => {
    // Shape only, again: a row naming a contract this phone does not provide is a row the
    // registry refuses at install with a message a player can read. Dropping it here would
    // hide it behind a console warning instead.
    expect(isCatalogEntry({ ...validEntry, sdkContract: '1' })).toBe(true);
    expect(isCatalogEntry({ ...validEntry, sdkContract: '99' })).toBe(true);
    expect(isCatalogEntry({ ...validEntry, sdkContract: 1 })).toBe(false);
  });

  it('rejects an entry with no permissions array', () => {
    const { permissions: _permissions, ...withoutPermissions } = validEntry;
    expect(isCatalogEntry(withoutPermissions)).toBe(false);
    expect(isCatalogEntry({ ...validEntry, permissions: 'contacts' })).toBe(false);
  });

  it('rejects an entry declaring a permission outside ALL_PERMISSIONS', () => {
    expect(isCatalogEntry({ ...validEntry, permissions: ['not-a-real-permission'] })).toBe(false);
  });

  /**
   * MICA-91. A catalog is remote data and its `color` is a wire field, so it stays a
   * string here rather than becoming a `tile` — but "non-empty string" was the whole of
   * the check, and a colour value that names no `bg-` class is interpolated into a `class`
   * attribute and lists the app with an invisible tile. Dropped and logged now, like any
   * other malformed row.
   */
  it('rejects an entry whose colour names no background class', () => {
    expect(isCatalogEntry({ ...validEntry, color: '#4ade80' })).toBe(false);
    expect(isCatalogEntry({ ...validEntry, color: 'emerald' })).toBe(false);
    expect(isCatalogEntry({ ...validEntry, color: 'text-gray-900' })).toBe(false);
  });

  it('still accepts a colour carrying both roles, as a published catalog may', () => {
    expect(isCatalogEntry({ ...validEntry, color: 'bg-green-400 text-gray-900' })).toBe(true);
  });
});
