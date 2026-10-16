// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The one caller of `setTrustedRemoteAppHosts` and `setRemoteCatalogUrl` in a shipped build
 * (MICA-126).
 *
 * Both setters were tested, exported from `@mica/sdk`, and reachable from nothing — so
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
  const security = await import('../../../../sdk/remoteAppSecurity');
  const catalog = await import('../../../../sdk/catalog');
  return { ...config, ...security, ...catalog };
};

beforeEach(async () => {
  // Fake throughout, so a retry a failure schedules can never fire inside a later case.
  vi.useFakeTimers();
  vi.resetModules();
  fetchNui.mockReset();
  rehydrateSavedRemoteApps.mockReset();
  rehydrateSavedRemoteApps.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/**
 * A refused request, answered the way the real `fetchNui` answers one: the default when the
 * caller asked for one, a throw when it did not.
 */
const refuse = (_event: string, _data?: unknown, options?: { defaultValue?: unknown }) =>
  options?.defaultValue !== undefined
    ? Promise.resolve(options.defaultValue)
    : Promise.reject(new Error('callback not registered'));

describe('loadRemoteAppConfig', () => {
  it('asks the client for the operator convars', async () => {
    fetchNui.mockResolvedValue({ hosts: [], catalogUrl: '' });
    const { loadRemoteAppConfig } = await load();
    await loadRemoteAppConfig();
    expect(fetchNui).toHaveBeenCalledWith('remoteAppConfig', {});
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

  /**
   * MICA-384. This was asked once, at `Shell.svelte`'s mount, and a failure there — the
   * client's callback not yet registered at resource start — kept every saved add-on off the
   * launcher for the session. It still fails closed; it now asks again.
   */
  describe('a failed ask', () => {
    it('fails closed and retries until the client answers', async () => {
      fetchNui.mockImplementation(refuse);
      const { loadRemoteAppConfig, isTrustedRemoteUrl } = await load();

      await expect(loadRemoteAppConfig()).resolves.toEqual({ hosts: [], catalogUrl: '' });
      expect(isTrustedRemoteUrl('https://store.example.com/blabber.js')).toBe(false);
      expect(rehydrateSavedRemoteApps).not.toHaveBeenCalled();

      fetchNui.mockResolvedValue({ hosts: ['store.example.com'], catalogUrl: '' });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(fetchNui).toHaveBeenCalledTimes(2);
      expect(isTrustedRemoteUrl('https://store.example.com/blabber.js')).toBe(true);
      expect(rehydrateSavedRemoteApps).toHaveBeenCalledTimes(1);
    });

    it('backs off while the failures continue, and stops once answered', async () => {
      fetchNui.mockImplementation(refuse);
      const { loadRemoteAppConfig } = await load();
      await loadRemoteAppConfig();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchNui).toHaveBeenCalledTimes(2);
      // The second retry waits twice as long as the first.
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchNui).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchNui).toHaveBeenCalledTimes(3);

      fetchNui.mockResolvedValue({ hosts: [], catalogUrl: '' });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(fetchNui).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchNui).toHaveBeenCalledTimes(4);
    });

    it('retries a reply that is not a configuration, too', async () => {
      fetchNui.mockResolvedValue('not a config');
      const { loadRemoteAppConfig } = await load();
      await loadRemoteAppConfig();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchNui).toHaveBeenCalledTimes(2);
    });

    it('keeps a configuration already applied through a later failure', async () => {
      fetchNui.mockResolvedValue({ hosts: ['store.example.com'], catalogUrl: '' });
      const { loadRemoteAppConfig, isTrustedRemoteUrl } = await load();
      await loadRemoteAppConfig();

      fetchNui.mockImplementation(refuse);
      await expect(loadRemoteAppConfig()).resolves.toEqual({
        hosts: ['store.example.com'],
        catalogUrl: ''
      });
      expect(isTrustedRemoteUrl('https://store.example.com/blabber.js')).toBe(true);
    });
  });
});
