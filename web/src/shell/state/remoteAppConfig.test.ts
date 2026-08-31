import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The one caller of `setTrustedRemoteAppHosts` and `setRemoteCatalogUrl` in a shipped build
 * (MICA-126).
 *
 * Both setters were tested, exported from `@gphone/sdk`, and reachable from nothing — so
 * the tests here are about the *wiring* rather than about the setters: that the reply is
 * asked for, that it is applied, that an absent one leaves the phone in the
 * configured-nothing state, and that the registry re-verifies saved installs only once
 * there is an allowlist to verify them against.
 */
const fetchNui = vi.fn();
const rehydrateSavedRemoteApps = vi.fn(async () => undefined);

vi.mock('../../nui/fetchNui', () => ({
  fetchNui: (...args: unknown[]) => fetchNui(...args)
}));

vi.mock('./registry', () => ({
  appRegistryStore: {
    rehydrateSavedRemoteApps: () => rehydrateSavedRemoteApps()
  }
}));

const load = async () => {
  const config = await import('./remoteAppConfig');
  const security = await import('../../sdk/remoteAppSecurity');
  const catalog = await import('../../sdk/catalog');
  return { ...config, ...security, ...catalog };
};

beforeEach(async () => {
  vi.resetModules();
  fetchNui.mockReset();
  rehydrateSavedRemoteApps.mockReset();
  rehydrateSavedRemoteApps.mockResolvedValue(undefined);
});

describe('loadRemoteAppConfig', () => {
  it('asks the client for the operator convars', async () => {
    fetchNui.mockResolvedValue({ hosts: [], catalogUrl: '' });
    const { loadRemoteAppConfig } = await load();
    await loadRemoteAppConfig();
    expect(fetchNui).toHaveBeenCalledWith('remoteAppConfig', {}, expect.anything());
  });

  it('leaves the phone configured-nothing when the server sets neither convar', async () => {
    // The stock build, and the case that has to be exactly what it was before this file
    // existed: no host trusted, no catalog, nothing remote installable.
    fetchNui.mockResolvedValue({ hosts: [], catalogUrl: '' });
    const {
      loadRemoteAppConfig,
      getTrustedRemoteAppHosts,
      getRemoteCatalogUrl,
      isTrustedRemoteUrl
    } = await load();

    await loadRemoteAppConfig();

    expect(getTrustedRemoteAppHosts()).toEqual([]);
    expect(getRemoteCatalogUrl()).toBeUndefined();
    expect(isTrustedRemoteUrl('https://store.example.com/blabber.js')).toBe(false);
  });

  it('applies an operator allowlist, which is what unblocks every install', async () => {
    fetchNui.mockResolvedValue({
      hosts: ['store.example.com'],
      catalogUrl: 'https://store.example.com/catalog.json'
    });
    const { loadRemoteAppConfig, getRemoteCatalogUrl, isTrustedRemoteUrl } = await load();

    await loadRemoteAppConfig();

    expect(isTrustedRemoteUrl('https://store.example.com/blabber.js')).toBe(true);
    expect(isTrustedRemoteUrl('https://evil.example.com/blabber.js')).toBe(false);
    expect(getRemoteCatalogUrl()).toBe('https://store.example.com/catalog.json');
  });

  it('re-verifies saved remote installs, but only once there is an allowlist', async () => {
    // `registry.ts` kicks this off at module load, before any config can have arrived, and
    // returns early while the allowlist is empty. If this call did not happen, an add-on
    // installed last session would be missing from the launcher this session.
    fetchNui.mockResolvedValue({ hosts: [], catalogUrl: '' });
    const first = await load();
    await first.loadRemoteAppConfig();
    expect(rehydrateSavedRemoteApps).not.toHaveBeenCalled();

    vi.resetModules();
    fetchNui.mockResolvedValue({ hosts: ['store.example.com'], catalogUrl: '' });
    const second = await load();
    await second.loadRemoteAppConfig();
    expect(rehydrateSavedRemoteApps).toHaveBeenCalledTimes(1);
  });

  it('falls back to configured-nothing when the bridge answers with junk', async () => {
    fetchNui.mockResolvedValue('not a config');
    const { loadRemoteAppConfig, getTrustedRemoteAppHosts, getRemoteCatalogUrl } = await load();

    await loadRemoteAppConfig();

    expect(getTrustedRemoteAppHosts()).toEqual([]);
    expect(getRemoteCatalogUrl()).toBeUndefined();
  });

  it('hands back what it applied, rather than leaving a caller to ask again', async () => {
    fetchNui.mockResolvedValue({ hosts: ['store.example.com'], catalogUrl: '' });
    const { loadRemoteAppConfig } = await load();

    await expect(loadRemoteAppConfig()).resolves.toEqual({
      hosts: ['store.example.com'],
      catalogUrl: ''
    });
  });
});
