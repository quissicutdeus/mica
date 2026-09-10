// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-234: an app the server owner disables does not exist, as far as an app or an add-on
 * can tell.
 *
 * This file is the contract, stated from the consumer's side. The hooks under test are
 * one-line pass-throughs to their facets, so none of the filtering is in the SDK: it is in
 * the shell's facets and state (`web/src/host/facets/*`, `shell/state/navigation.ts`,
 * `shell/state/registry.ts`), reading `shell/state/ownerConfig.ts`. A filter placed in a hook
 * would be decoration for the half that matters most — an add-on's raw `postMessage` never
 * runs the hook — so the second block drives `IframeHostServer` directly, the way a frame's
 * own script can.
 *
 * In-process facet set, because a unit test stands in for the shell (MICA-176).
 *
 * What an add-on can reach is `FACET_MEMBERS` in `sdk/permissions.ts`. Of those, the only
 * members that answer with another app's manifest are `appRegistry.registryStore`, and the
 * only ones that act on another app's id are `navigation.openApp`; both are covered below.
 * A row added to that table that answers with manifests belongs in this file too.
 *
 * Every assertion pairs a refusal with its control — the same call succeeding once the owner
 * re-enables the app — so a red refusal means "not refused", never "the fixture was wrong".
 */
import '../../web/src/host/registerFacets';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

const nui = vi.hoisted(() => ({ fetchNui: vi.fn() }));
vi.mock('../../web/src/nui/fetchNui', () => nui);

import { ownerConfig } from '../../web/src/shell/state/ownerConfig';
import { appRegistryStore } from '../../web/src/shell/state/registry';
import { currentApp, goHome } from '../../web/src/shell/state/navigation';
import { recordConsent, resetGrantsForTest } from '../../web/src/shell/state/addOnGrants';
import { capabilities, capabilitiesKnown } from '../../web/src/services/capabilities';
import { createIframeHostServer } from '../../web/src/shell/addon/IframeHostServer';
import { createInProcessHost } from './inProcess/createInProcessHost';
import type { ToFrame } from './iframe/messages';
import { defineApp, type AppManifest, type AppPermission } from '../manifest';
import type { CatalogEntry } from '../catalog';
import { setTrustedRemoteAppHosts, sha256Hex } from '../remoteAppSecurity';
import { useAppRegistry } from './useAppRegistry';
import { useAppRegistryWrite } from './useAppRegistryWrite';
import { useNavigation } from './useNavigation';

/** A core app, always in the installed list and always openable on the phone. */
const CORE_ID = 'calculator';
/** A bundled add-on: offered by the Store, installed only when somebody installs it. */
const ADDON_ID = 'notes';
/** A catalog add-on, which no build ships. */
const REMOTE_ID = 'remote_weather';

const disable = (...ids: string[]) => ownerConfig.set({ disabledApps: ids, defaultDock: [] });

const ids = (apps: readonly AppManifest[]) => apps.map((a) => a.id);

/** The shell's own, unfiltered view — what the owner's config is being checked against. */
const shellHas = (appId: string) => appRegistryStore.isInstalled(appId);

const bundledAddOn = (): AppManifest => {
  const manifest = appRegistryStore.getManifest(ADDON_ID);
  if (!manifest) throw new Error(`fixture: '${ADDON_ID}' is no longer a bundled add-on`);
  return manifest;
};

beforeEach(() => {
  nui.fetchNui.mockResolvedValue(undefined);
  // The shell's refusals are a warning and a return; that is the behaviour, not noise.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  disable();
  goHome();
  for (const id of [ADDON_ID, REMOTE_ID]) {
    if (shellHas(id)) appRegistryStore.unregisterApp(id);
  }
  vi.restoreAllMocks();
});

describe('an owner-disabled app, seen by a core app through the SDK hooks', () => {
  it('leaves the installed list live, and comes back when the owner re-enables it', () => {
    appRegistryStore.registerAddOn(bundledAddOn());
    const { registryStore } = useAppRegistry();
    let seen: string[] = [];
    const stop = registryStore.subscribe((apps) => (seen = ids(apps)));

    expect(seen).toEqual(expect.arrayContaining([CORE_ID, ADDON_ID]));

    // After the subscription, as in game: the config arrives after the list does.
    disable(CORE_ID, ADDON_ID);
    expect(seen).not.toContain(CORE_ID);
    expect(seen).not.toContain(ADDON_ID);

    disable();
    expect(seen).toEqual(expect.arrayContaining([CORE_ID, ADDON_ID]));
    stop();
  });

  it('is not offered as a bundled add-on', () => {
    expect(ids(useAppRegistry().bundledAddOns)).toContain(ADDON_ID);

    disable(ADDON_ID);
    expect(ids(useAppRegistry().bundledAddOns)).not.toContain(ADDON_ID);
  });

  it('cannot be looked up by id', () => {
    appRegistryStore.registerAddOn(bundledAddOn());
    const { registryStore } = useAppRegistry();

    expect(registryStore.getManifest(ADDON_ID)?.id).toBe(ADDON_ID);
    expect(registryStore.isInstalled(ADDON_ID)).toBe(true);
    expect(registryStore.isKnownApp(ADDON_ID)).toBe(true);

    disable(ADDON_ID);
    expect(registryStore.getManifest(ADDON_ID)).toBeUndefined();
    expect(registryStore.isInstalled(ADDON_ID)).toBe(false);
    expect(registryStore.isKnownApp(ADDON_ID)).toBe(false);
  });

  it('cannot be opened, the way an id naming no app cannot, and opens once re-enabled', () => {
    const { openApp } = useNavigation();

    disable(CORE_ID);
    expect(() => openApp(CORE_ID, { from: 'deep link' })).not.toThrow();
    expect(get(currentApp).id).toBe('home');

    disable();
    openApp(CORE_ID);
    expect(get(currentApp).id).toBe(CORE_ID);
  });

  it('cannot be installed from the Store as a bundled add-on', () => {
    const { registerAddOn } = useAppRegistryWrite();

    disable(ADDON_ID);
    try {
      registerAddOn(bundledAddOn());
    } catch {
      // A refusal may throw or return; either way nothing may be installed.
    }
    expect(shellHas(ADDON_ID)).toBe(false);

    disable();
    registerAddOn(bundledAddOn());
    expect(shellHas(ADDON_ID)).toBe(true);
  });

  it('cannot be installed from a catalog', async () => {
    const code = `export const manifest = { id: '${REMOTE_ID}' };`;
    const entry: CatalogEntry = {
      id: REMOTE_ID,
      name: 'Weather',
      version: '1.0.0',
      description: 'A catalog add-on the owner has disabled.',
      bundleUrl: 'https://store.example.com/apps/weather.js',
      sha256: await sha256Hex(code),
      color: 'bg-blue-500',
      permissions: ['storage']
    };
    setTrustedRemoteAppHosts(['store.example.com']);
    capabilities.set({ money: true });
    capabilitiesKnown.set(true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: '',
        text: () => Promise.resolve(code)
      } as Response)
    );
    const { installFromCatalog } = useAppRegistryWrite();

    disable(REMOTE_ID);
    await expect(installFromCatalog(entry)).rejects.toThrow();
    expect(shellHas(REMOTE_ID)).toBe(false);

    disable();
    await expect(installFromCatalog(entry)).resolves.toMatchObject({
      manifest: { id: REMOTE_ID }
    });
    expect(shellHas(REMOTE_ID)).toBe(true);
  });
});

describe('an owner-disabled app, seen by a sandboxed add-on over postMessage', () => {
  const PERMISSIONS: AppPermission[] = ['app-registry', 'navigation'];
  const probe = defineApp({
    id: 'probe',
    name: 'Probe',
    icon: 'x',
    tile: { bg: 'bg-gray-900' },
    core: false,
    permissions: PERMISSIONS
  });

  beforeEach(() => {
    resetGrantsForTest();
  });

  /** The frame's side of the wire, with `origin` as a real sandboxed srcdoc sends it. */
  function frame() {
    recordConsent(probe.id, PERMISSIONS);
    const posted: ToFrame[] = [];
    const guest = { postMessage: (m: ToFrame) => posted.push(m) };
    const server = createIframeHostServer({
      host: createInProcessHost(probe.id, PERMISSIONS),
      manifest: probe,
      props: {},
      guest: () => guest,
      onError: vi.fn(),
      onKey: vi.fn(),
      onTyping: vi.fn()
    });
    const send = (data: unknown) =>
      server.handle({ data, source: guest, origin: 'null' } as unknown as MessageEvent);
    const lastPush = (id: number): string[] => {
      const pushes = posted.filter((m) => m.kind === 'push' && m.id === id);
      const last = pushes[pushes.length - 1];
      if (!last || last.kind !== 'push') throw new Error(`no push for subscription ${id}`);
      return ids(last.value as AppManifest[]);
    };
    const replied = (id: number) =>
      vi.waitFor(() => expect(posted.some((m) => m.kind === 'reply' && m.id === id)).toBe(true));
    return { send, lastPush, replied };
  }

  it('is missing from every registry push, including the ones after the owner changes their mind', () => {
    const { send, lastPush } = frame();
    send({
      kind: 'subscribe',
      id: 1,
      facet: 'appRegistry',
      factoryArgs: [],
      member: 'registryStore'
    });

    expect(lastPush(1)).toContain(CORE_ID);

    disable(CORE_ID);
    expect(lastPush(1)).not.toContain(CORE_ID);

    disable();
    expect(lastPush(1)).toContain(CORE_ID);
  });

  it('cannot open it', async () => {
    const { send, replied } = frame();
    const openApp = (id: number) =>
      send({
        kind: 'call',
        id,
        facet: 'navigation',
        factoryArgs: [],
        member: 'openApp',
        args: [CORE_ID]
      });

    disable(CORE_ID);
    openApp(1);
    await replied(1);
    expect(get(currentApp).id).toBe('home');

    disable();
    openApp(2);
    await replied(2);
    expect(get(currentApp).id).toBe(CORE_ID);
  });
});
