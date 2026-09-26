// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-169. Stands in for the shell: `registerFacets` is what loads `capabilitiesSync.ts`,
 * so the hook below answers from the same stores the launcher and the install gate read.
 */
import '../web/src/host/registerFacets';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { useCapabilities } from './core';
import * as publicSdk from './index';
import * as addOnSdk from './addon';
import { permissionOfFacet } from './permissions';
import { capabilities, capabilitiesKnown } from '../web/src/services/capabilities';
import { createIframeHostServer } from '../web/src/shell/addon/IframeHostServer';
import { createInProcessHost } from './host/inProcess/createInProcessHost';
import { resetHostsForTest } from './host/current';
import { recordConsent, resetGrantsForTest } from '../web/src/shell/state/addOnGrants';
import { __resetSettingsSync } from '../web/src/host/settingsSync';
import { defineApp } from './manifest';
import type { ToFrame } from './host/iframe/messages';

const initial = { caps: get(capabilities), known: get(capabilitiesKnown) };

afterEach(() => {
  capabilities.set(initial.caps);
  capabilitiesKnown.set(initial.known);
});

describe('useCapabilities answers from the shell', () => {
  it('reports what `requires` names and the server lacks', () => {
    capabilities.set({ money: false, jobs: true });
    capabilitiesKnown.set(true);
    const caps = useCapabilities();
    expect(caps.known).toBe(true);
    expect(caps.missing(['money', 'jobs'])).toEqual(['money']);
    expect(caps.missing(['jobs'])).toEqual([]);
    expect(caps.missing(undefined)).toEqual([]);
    expect(caps.missing(['money', 'money'])).toEqual(['money']);
  });

  it('reports nothing missing until the server has answered', () => {
    capabilities.set({ money: false, jobs: false });
    capabilitiesKnown.set(false);
    const caps = useCapabilities();
    expect(caps.known).toBe(false);
    expect(caps.missing(['money'])).toEqual([]);
    expect(get(caps).known).toBe(false);
  });

  it('is a store that follows the answer as it lands and changes', () => {
    capabilitiesKnown.set(false);
    const caps = useCapabilities();
    const seen: string[][] = [];
    const stop = caps.subscribe((a) => seen.push([...a.missing(['money'])]));
    capabilities.set({ money: false, jobs: false });
    capabilitiesKnown.set(true);
    capabilities.set({ money: true, jobs: false });
    stop();
    expect(seen[0]).toEqual([]);
    expect(seen).toContainEqual(['money']);
    expect(seen[seen.length - 1]).toEqual([]);
  });
});

describe('an add-on cannot reach it', () => {
  it('is on @mica/sdk/core only, not on either public barrel', () => {
    expect('useCapabilities' in publicSdk).toBe(false);
    expect('useCapabilities' in addOnSdk).toBe(false);
  });

  it('has no facet, so a frame naming one is refused as unknown', async () => {
    expect(permissionOfFacet('capabilities')).toBeUndefined();

    resetHostsForTest();
    resetGrantsForTest();
    const manifest = defineApp({
      id: 'probe',
      name: 'Probe',
      icon: 'x',
      tile: { bg: 'bg-gray-900' },
      core: false,
      permissions: []
    });
    recordConsent('probe', []);
    const posted: ToFrame[] = [];
    const guest = { postMessage: (m: ToFrame) => posted.push(m) };
    const s = createIframeHostServer({
      host: createInProcessHost('probe', []),
      manifest,
      props: {},
      guest: () => guest,
      onError: vi.fn(),
      onKey: vi.fn(),
      onTyping: vi.fn()
    });
    s.handle({
      data: {
        kind: 'call',
        id: 1,
        facet: 'capabilities',
        factoryArgs: [],
        member: 'missing',
        args: [['money']]
      },
      source: guest,
      origin: 'null'
    } as unknown as MessageEvent);
    await Promise.resolve();
    expect(posted.map((m) => (m as any).ok)).toEqual([false]);
    s.dispose?.();
    __resetSettingsSync();
  });
});
