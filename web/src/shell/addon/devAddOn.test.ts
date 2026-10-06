// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-311: the shell's dev add-on loader. Every refusal, that nothing half-registers or
 * persists, the strip's Reload, and that a page loaded without `?addonDev=` has no trace
 * of the add-on. In-process facets, because this stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';

const serviceMock = vi.hoisted(() => ({
  fetchSettings: vi.fn().mockResolvedValue([]),
  saveSetting: vi.fn(),
  removeSetting: vi.fn(),
  clearAppSettings: vi.fn()
}));
vi.mock('../../services/settings', () => serviceMock);

/**
 * jsdom here has no `localStorage` (see `registry.test.ts`), and `registry.ts` and
 * `usePersisted` both read the bare global. One installed before any import, so every
 * module under test writes into this backing and "nothing persisted" means something.
 */
const storage = vi.hoisted(() => {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return backing.size;
    },
    key: (i: number) => [...backing.keys()][i] ?? null,
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear()
  };
  return backing;
});

import {
  DEV_FETCH_INIT,
  devAddOn,
  loadDevAddOn,
  reloadDevAddOn,
  resetDevAddOnForTest,
  setDevAddOnDeps,
  startDevAddOn,
  type DevAddOnDeps
} from './devAddOn';
import DevAddOnStrip from './DevAddOnStrip.svelte';
import RunningAddOnFrames from '../__fixtures__/RunningAddOnFrames.svelte';
import { setTrustedRemoteAppHosts, sha256Hex } from '../../../../sdk/remoteAppSecurity';
import { appRegistryStore, grantFor } from '../state/registry';
import { currentApp, closeAllApps, closeApp, openApp } from '../state/navigation';
import { isCatalogEntry, type CatalogEntry } from '../../../../sdk/catalog';
import { hostRuntime } from '@mica/sdk';
import { t } from '../messages';
import { homeGridItems } from '../state/homeGrid';
import { dockAppIds } from '../state/dock';
import { MICA_DEV_ADDON_MARKER } from '@mica/shared/addonDev';

const BASE = 'http://127.0.0.1:5174/';
const ID = 'devhello';

const entry = (over: Record<string, unknown> = {}) => ({
  id: ID,
  name: 'Dev Hello',
  version: '0.0.1',
  description: 'A dev add-on',
  bundleUrl: `${BASE}app.js`,
  sha256: 'not-checked-on-the-dev-path',
  color: 'bg-sky-500',
  permissions: ['notifications'],
  ...over
});

interface Fake {
  ok: boolean;
  status: number;
  redirected: boolean;
  type: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}
const reply = (body: unknown, status = 200): Fake => ({
  ok: status >= 200 && status < 300,
  status,
  redirected: false,
  type: 'basic',
  json: () =>
    typeof body === 'string' ? Promise.resolve(JSON.parse(body)) : Promise.resolve(body),
  text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
});

/** A dev server: the entry at `mica-dev.json`, the bundle at its `bundleUrl`. */
const serve = (e: unknown, code = 'console.log("v1")') =>
  vi.fn(async (url: string) => (url.endsWith('mica-dev.json') ? reply(e) : reply(code)));

const snapshotStorage = () => Object.fromEntries(storage);

let fetchMock: ReturnType<typeof serve>;

/** What `Shell.svelte` hands the loader, made of the same real pieces. */
const showError = vi.fn();
const shellDeps = (): DevAddOnDeps => ({
  registerDevAddOn: appRegistryStore.registerDevAddOn,
  unregisterDevAddOn: appRegistryStore.unregisterDevAddOn,
  isCatalogEntry,
  hostRuntime,
  openApp,
  closeApp,
  showError
});
const strip = (appId: string) => render(DevAddOnStrip, { props: { appId, t: get(t) } });

beforeEach(() => {
  localStorage.clear();
  serviceMock.saveSetting.mockClear();
  fetchMock = serve(entry());
  vi.stubGlobal('fetch', fetchMock);
  showError.mockClear();
  setDevAddOnDeps(shellDeps());
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  resetDevAddOnForTest();
  closeAllApps();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.invokeNative;
});

const registered = (id = ID) => get(appRegistryStore).some((a) => a.id === id);

describe('dev add-on loader: refusals', () => {
  it.each([
    ['a non-loopback host', 'http://example.com/', /not loopback/],
    ['a lookalike host', 'http://localhost.evil.com/', /not loopback/],
    ['a base with a query', 'http://localhost:5174/?x=1', /no query/],
    ['a non-http protocol', 'file:///tmp/', /http or https/]
  ])('refuses %s before any request', async (_label, raw, reason) => {
    const result = await loadDevAddOn(raw);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(get(devAddOn)).toBeNull();
  });

  it('refuses outside a browser tab (CEF), before any request', async () => {
    window.invokeNative = () => {};
    const result = await loadDevAddOn(BASE);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/browser only/) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(registered()).toBe(false);
  });

  it('refuses a redirect, which `redirect: error` turns into a rejected fetch', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const result = await loadDevAddOn(BASE);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/redirect/) });
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}mica-dev.json`, DEV_FETCH_INIT);
    expect(registered()).toBe(false);
  });

  it('refuses a response that reports it was redirected', async () => {
    fetchMock.mockResolvedValueOnce({ ...reply(entry()), redirected: true });
    const result = await loadDevAddOn(BASE);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/redirected/) });
    expect(registered()).toBe(false);
  });

  it('refuses an HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(reply('nope', 404));
    const result = await loadDevAddOn(BASE);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/HTTP 404/) });
  });

  it.each([
    ['another port', 'http://127.0.0.1:9999/app.js'],
    ['another host', 'https://cdn.example.com/app.js'],
    ['another protocol', 'https://127.0.0.1:5174/app.js']
  ])('refuses a bundleUrl on %s, and never fetches it', async (_label, bundleUrl) => {
    vi.stubGlobal('fetch', (fetchMock = serve(entry({ bundleUrl }))));
    const result = await loadDevAddOn(BASE);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/is not on/) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(registered()).toBe(false);
  });

  it.each([
    ['missing fields', { id: ID }],
    ['an unknown permission', entry({ permissions: ['root'] })],
    ['a colour that names no class', entry({ color: '#ff0000' })]
  ])('refuses an invalid entry (%s)', async (_label, e) => {
    vi.stubGlobal('fetch', (fetchMock = serve(e)));
    const result = await loadDevAddOn(BASE);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/not a valid/) });
    expect(registered()).toBe(false);
  });

  it('refuses an entry that is not JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ...reply(''),
      json: () => Promise.reject(new SyntaxError('bad'))
    });
    const result = await loadDevAddOn(BASE);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/not JSON/) });
  });

  it.each([
    ['a core app', 'settings'],
    ['a bundled add-on', 'notes']
  ])('refuses an id collision with %s, leaving it untouched', async (_label, id) => {
    const before = get(appRegistryStore).find((a) => a.id === id);
    vi.stubGlobal('fetch', (fetchMock = serve(entry({ id }))));
    const result = await loadDevAddOn(BASE);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/already an app/) });
    expect(appRegistryStore.isDevAddOn(id)).toBe(false);
    expect(get(appRegistryStore).find((a) => a.id === id)).toEqual(before);
  });

  it('refuses through the real registerAddOn checks, and half-registers nothing', async () => {
    // `services` outside the app's own namespace — `defineApp` refuses it.
    vi.stubGlobal('fetch', (fetchMock = serve(entry({ services: ['bank'] }))));
    const result = await loadDevAddOn(BASE);
    expect(result.ok).toBe(false);
    expect(registered()).toBe(false);
    expect(appRegistryStore.isDevAddOn(ID)).toBe(false);
    expect(appRegistryStore.isKnownApp(ID)).toBe(false);
    expect(grantFor(ID)).toEqual([]);
  });

  it('names the reason once, in a toast and the console, from the boot path', async () => {
    const result = await startDevAddOn(shellDeps(), '?addonDev=http%3A%2F%2Fexample.com%2F');
    expect(result).toMatchObject({ ok: false });
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('is not loopback'));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`${MICA_DEV_ADDON_MARKER}: 'example.com' is not loopback`)
    );
  });
});

describe('dev add-on loader: a load', () => {
  it('registers through the add-on path, opens it, and fetches both files with the dev init', async () => {
    const result = await loadDevAddOn(BASE);
    expect(result).toEqual({ ok: true, appId: ID });
    expect(fetchMock).toHaveBeenNthCalledWith(1, `${BASE}mica-dev.json`, DEV_FETCH_INIT);
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${BASE}app.js`, DEV_FETCH_INIT);
    expect(DEV_FETCH_INIT).toEqual({ redirect: 'error', credentials: 'omit', cache: 'no-store' });

    const manifest = appRegistryStore.getManifest(ID);
    expect(manifest).toMatchObject({ id: ID, core: false });
    expect(manifest?.isRemote).toBeUndefined();
    expect(manifest?.bundleUrl).toBeUndefined();
    expect(await appRegistryStore.getAddOnSource(ID)).toBe('console.log("v1")');
    expect(grantFor(ID)).toEqual(['notifications']);
    expect(get(currentApp).id).toBe(ID);
    expect(get(devAddOn)).toMatchObject({ appId: ID, source: '127.0.0.1:5174', error: null });
  });

  it('persists nothing: no storage key, no server save, no home-grid cell', async () => {
    const before = snapshotStorage();
    const gridBefore = get(homeGridItems);
    await loadDevAddOn(BASE);
    expect(registered()).toBe(true);
    // Past `usePersisted`'s debounce, so a queued server save would have fired.
    await new Promise((r) => setTimeout(r, 1200));
    expect(snapshotStorage()).toEqual(before);
    expect(serviceMock.saveSetting).not.toHaveBeenCalled();
    expect(get(homeGridItems)).toEqual(gridBefore);
  });

  it("the Store's Uninstall takes the in-memory path and writes nothing either", async () => {
    await loadDevAddOn(BASE);
    const before = snapshotStorage();
    appRegistryStore.unregisterApp(ID);
    expect(registered()).toBe(false);
    expect(grantFor(ID)).toEqual([]);
    expect(snapshotStorage()).toEqual(before);
  });

  it('with no ?addonDev= at all, does nothing', async () => {
    expect(await startDevAddOn(shellDeps(), '?app=notes')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(get(devAddOn)).toBeNull();
  });
});

describe('dev add-on strip', () => {
  it('names the source, says it is not verified, and draws nothing for another app', async () => {
    await loadDevAddOn(BASE);
    const { getByTestId } = strip(ID);
    expect(getByTestId(MICA_DEV_ADDON_MARKER).textContent).toContain(
      'Dev add-on from 127.0.0.1:5174, not verified'
    );
    const other = strip('notes');
    expect(other.container.querySelector(`[data-testid="${MICA_DEV_ADDON_MARKER}"]`)).toBeNull();
  });

  it('Reload re-fetches, re-registers the new bundle, and reopens it', async () => {
    await loadDevAddOn(BASE);
    vi.stubGlobal('fetch', (fetchMock = serve(entry({ version: '0.0.2' }), 'console.log("v2")')));
    const { getByTestId } = strip(ID);
    await fireEvent.click(getByTestId(`${MICA_DEV_ADDON_MARKER}-reload`));
    await waitFor(() => expect(get(devAddOn)?.busy).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await appRegistryStore.getAddOnSource(ID)).toBe('console.log("v2")');
    expect(appRegistryStore.getManifest(ID)?.version).toBe('0.0.2');
    expect(get(currentApp).id).toBe(ID);
    expect(get(appRegistryStore).filter((a) => a.id === ID)).toHaveLength(1);
  });

  it('a failed Reload keeps the running copy and shows why in the strip', async () => {
    await loadDevAddOn(BASE);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { getByTestId, findByTestId } = strip(ID);
    await fireEvent.click(getByTestId(`${MICA_DEV_ADDON_MARKER}-reload`));
    const error = await findByTestId(`${MICA_DEV_ADDON_MARKER}-error`);
    expect(error.textContent).toMatch(/Is the dev server running/);
    expect(await appRegistryStore.getAddOnSource(ID)).toBe('console.log("v1")');
    expect(registered()).toBe(true);
  });

  it('a Reload whose new entry is refused puts the old copy back', async () => {
    await loadDevAddOn(BASE);
    vi.stubGlobal('fetch', (fetchMock = serve(entry({ id: 'settings' }))));
    const result = await reloadDevAddOn();
    expect(result.ok).toBe(false);
    expect(appRegistryStore.isDevAddOn(ID)).toBe(true);
    expect(await appRegistryStore.getAddOnSource(ID)).toBe('console.log("v1")');
    expect(get(devAddOn)?.error).toMatch(/already an app/);
  });
});

describe('dev add-on leftovers', () => {
  it('a page loaded again without ?addonDev= has no grid cell, dock entry, drawer or search hit', async () => {
    await loadDevAddOn(BASE);
    expect(registered()).toBe(true);
    // What a reload reads back is the browser's storage and the settings service; the load
    // wrote the id into neither.
    expect(JSON.stringify(snapshotStorage())).not.toContain(ID);
    expect(JSON.stringify(serviceMock.saveSetting.mock.calls)).not.toContain(ID);

    // A reload is a fresh module graph over the same storage.
    vi.resetModules();
    await import('../../host/registerFacets');
    const fresh = await import('./devAddOn');
    const reg = await import('../state/registry');
    const grid = await import('../state/homeGrid');
    const dock = await import('../state/dock');

    expect(await fresh.startDevAddOn(shellDeps(), '')).toBeNull();
    expect(get(reg.appRegistryStore).some((a) => a.id === ID)).toBe(false);
    expect(reg.appRegistryStore.isKnownApp(ID)).toBe(false);
    expect(reg.appRegistryStore.getManifest(ID)).toBeUndefined();
    expect(reg.grantFor(ID)).toEqual([]);
    expect(JSON.stringify(get(grid.homeGridItems))).not.toContain(ID);
    expect(get(dock.dockAppIds)).not.toContain(ID);
    expect(get(dockAppIds)).not.toContain(ID);
  });
});

describe('dev add-on reload mounts a new frame', () => {
  const frameOf = (container: HTMLElement) =>
    container.querySelector<HTMLIFrameElement>(`iframe[data-app="${ID}"]`);

  it('Reload tears the old frame down and mounts a new one running the new code', async () => {
    const { container } = render(RunningAddOnFrames);
    await loadDevAddOn(BASE);
    const first = await waitFor(() => {
      const el = frameOf(container);
      if (!el) throw new Error('no frame yet');
      return el;
    });
    expect(first.getAttribute('srcdoc')).toContain('console.log("v1")');

    vi.stubGlobal('fetch', (fetchMock = serve(entry({ version: '0.0.2' }), 'console.log("v2")')));
    expect(await reloadDevAddOn()).toEqual({ ok: true, appId: ID });

    const second = await waitFor(() => {
      const el = frameOf(container);
      if (!el || el === first) throw new Error('still the old frame');
      return el;
    });
    expect(first.isConnected).toBe(false);
    expect(second.getAttribute('srcdoc')).toContain('console.log("v2")');
    expect(second.getAttribute('srcdoc')).not.toContain('console.log("v1")');
    expect(container.querySelectorAll(`iframe[data-app="${ID}"]`)).toHaveLength(1);
  });
});

describe('a dev id and a catalog install of the same id', () => {
  const STORE = 'https://store.example.com/apps/devhello.js';
  const published = 'console.log("published")';
  const catalogEntry = async (): Promise<CatalogEntry> => ({
    ...(entry({ bundleUrl: STORE, version: '1.0.0' }) as CatalogEntry),
    sha256: await sha256Hex(published)
  });
  const saveRow = async () =>
    localStorage.setItem(
      'mica_installed_remote_apps',
      JSON.stringify([{ url: STORE, entry: await catalogEntry() }])
    );

  beforeEach(() => setTrustedRemoteAppHosts(['store.example.com']));
  afterEach(() => setTrustedRemoteAppHosts([]));

  it('a saved install not yet rehydrated refuses a dev add-on of its id', async () => {
    await saveRow();
    const result = await loadDevAddOn(BASE);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/already an app/) });
    expect(appRegistryStore.isDevAddOn(ID)).toBe(false);
    expect(registered()).toBe(false);
  });

  it('a live dev add-on refuses a catalog install of its id, before fetching', async () => {
    await loadDevAddOn(BASE);
    fetchMock.mockClear();
    await expect(appRegistryStore.installFromCatalog(await catalogEntry())).rejects.toThrow(
      'loaded as a dev add-on'
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await appRegistryStore.getAddOnSource(ID)).toBe('console.log("v1")');
    expect(grantFor(ID)).toEqual(['notifications']);
  });

  it('a rehydration of the saved row skips the live dev id, with a log', async () => {
    await loadDevAddOn(BASE);
    await saveRow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await appRegistryStore.rehydrateSavedRemoteApps();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to re-hydrate'),
      expect.objectContaining({ message: expect.stringContaining('loaded as a dev add-on') })
    );
    expect(await appRegistryStore.getAddOnSource(ID)).toBe('console.log("v1")');
    expect(appRegistryStore.isDevAddOn(ID)).toBe(true);
  });

  it('a catalog install in flight when the dev add-on loads is refused when its fetch lands', async () => {
    let land!: (r: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url === STORE ? new Promise((resolve) => (land = resolve)) : fetchMock(url)
      )
    );
    const install = appRegistryStore.installFromCatalog(await catalogEntry());
    await loadDevAddOn(BASE);
    expect(appRegistryStore.isDevAddOn(ID)).toBe(true);
    land(reply(published));
    await expect(install).rejects.toThrow('loaded as a dev add-on');
    expect(await appRegistryStore.getAddOnSource(ID)).toBe('console.log("v1")');
    expect(localStorage.getItem('mica_installed_remote_apps')).toBeNull();
  });
});

describe('dev add-on chunk boundary', () => {
  /**
   * A value import from the dev chunk into the shell's own graph made Rolldown split the
   * shared modules into a chunk that evaluated before `host/registerFacets`, and every
   * DEV page load died on `host facet 'persisted' is not loaded`. No unit test can see
   * a chunk graph, so this holds the cause instead: these two files import values only
   * from `svelte`, `@mica/shared/addonDev` and each other.
   */
  it.each(['./devAddOn.ts', './DevAddOnStrip.svelte'])(
    '%s imports only types from the shell',
    async (file) => {
      const { readFileSync } = await import('node:fs');
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      const valueImports = [
        ...text.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)
      ].map((m) => m[1]);
      const allowed =
        /^(svelte(\/.*)?|@mica\/shared\/addonDev|\.\/devAddOn|\.\/DevAddOnStrip\.svelte)$/;
      expect(valueImports.filter((spec) => !allowed.test(spec))).toEqual([]);
    }
  );
});
