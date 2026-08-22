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

  it('rejects an entry with no permissions array', () => {
    const { permissions: _permissions, ...withoutPermissions } = validEntry;
    expect(isCatalogEntry(withoutPermissions)).toBe(false);
    expect(isCatalogEntry({ ...validEntry, permissions: 'contacts' })).toBe(false);
  });

  it('rejects an entry declaring a permission outside ALL_PERMISSIONS', () => {
    expect(isCatalogEntry({ ...validEntry, permissions: ['not-a-real-permission'] })).toBe(false);
  });
});
