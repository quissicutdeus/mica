// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../host/registerFacets';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { get } from 'svelte/store';
import Shell from './Shell.svelte';
import {
  closeAllApps,
  currentApp,
  goHome,
  openApp,
  runningApps,
  RESIDENT_MOUNT_DELAY_MS
} from './state/navigation';
import { appRegistryStore } from './state/registry';
import { openDevice } from './state/phoneOpen';
import { isLocked } from './state/lockScreen';
import { closeDrawer, openDrawer, searchQuery } from './state/appDrawer';
import { closeControlCenter, openControlCenter, orderedToggles } from './state/controlCenter';
import { searchNeedle, searchProviders } from './state/searchProviders';
import type { AppManifest } from '@mica/sdk';
import ResidentProbe from './__fixtures__/ResidentProbe.svelte';
import { hostForApp } from '../../../sdk/host/inProcess/createInProcessHost';

// Passed through, only counted: MICA-375 is about how often the shell asks.
vi.mock('../../../sdk/host/inProcess/createInProcessHost', async (actual) => {
  const real = await actual<typeof import('../../../sdk/host/inProcess/createInProcessHost')>();
  return { ...real, hostForApp: vi.fn(real.hostForApp) };
});

/**
 * jsdom has no Web Animations. The frame's fly-in and fly-out run on `element.animate`, and
 * an outro that never finishes would leave the closed frame in the DOM, so this one finishes
 * at once: the transition is not what is under test.
 */
Element.prototype.animate = vi.fn(() => {
  const animation = {
    cancel: () => {},
    finish: () => {},
    currentTime: 0,
    effect: { getComputedTiming: () => ({ duration: 0, progress: 1 }) },
    set onfinish(handler: (() => void) | null) {
      if (handler) queueMicrotask(handler);
    }
  };
  return animation as unknown as Animation;
});

/** What the client's `SendNUIMessage` delivers: a `message` with no `source`. */
const setVisible = (visible: boolean) => {
  window.dispatchEvent(
    new MessageEvent('message', { data: { action: 'setVisible', data: visible } })
  );
  flushSync();
};

/** Each resident app's slot, in `runningApps` order. */
const slots = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('main .relative.h-full.w-full > div.absolute.inset-0')
];

const APPS = ['calculator', 'notes', 'contacts'] as const;

const PROBE = 'residentprobe';

/** Whether the probe's Control Center tile is up — it is only while the probe is mounted. */
const probeTileUp = () => get(orderedToggles).some((t) => t.appId === PROBE);

/** Whether the probe answered the search that is being typed. */
const probeAnswered = () =>
  get(searchProviders).some(
    (p) => p.appId === PROBE && p.search(get(searchNeedle)).some((h) => h.title === 'Grocery list')
  );

/** Render the shell, which opens itself in a browser, and wait for the frame. */
/**
 * Rendered, and past the lock. The passcode answer starts unknown (MICA-385), so the first
 * open paints the lock screen until the mock's "no passcode" lands a tick later.
 */
const renderOpen = async () => {
  const view = render(Shell);
  await waitFor(() => expect(get(isLocked)).toBe(false));
  await waitFor(() => expect(view.container.querySelector('main')).not.toBeNull());
  return view;
};

/** Close and reopen, as the client's `setVisible` does. */
const reopen = async (container: HTMLElement) => {
  setVisible(false);
  await waitFor(() => expect(container.querySelector('main')).toBeNull());
  setVisible(true);
};

describe('Shell mounts the current app first after an open (MICA-356)', () => {
  beforeAll(async () => {
    // Warm every chunk first, so the assertions below are about mounting and not about a
    // lazy import still being in flight.
    for (const id of APPS) await appRegistryStore.loadComponent(id, 'phone');
    // Core, so it mounts in-process. The registry refuses to unregister a core app, so it
    // stays registered for the rest of this file, which has its own module graph.
    appRegistryStore.registerApp(
      {
        id: PROBE,
        name: 'Resident Probe',
        tile: { bg: 'bg-gray-900' },
        core: true
      } as unknown as AppManifest,
      ResidentProbe
    );
  }, 60_000);

  afterEach(() => {
    cleanup();
    closeDrawer();
    searchQuery.set('');
    closeControlCenter();
    closeAllApps();
    // The unmounted shell leaves its mirror where it was; the next render's open must be
    // a change, as the first open of a session is.
    openDevice.set(null);
  });

  it('builds a hidden resident app on switch, or once the intro is over', async () => {
    const { container } = await renderOpen();

    for (const id of APPS) {
      openApp(id);
      flushSync();
    }
    goHome();
    openApp('contacts');
    flushSync();
    expect(get(runningApps).map((a) => a.id)).toEqual([...APPS]);
    // Before the close every app was on screen at some point, so every slot is built.
    expect(slots(container).map((s) => s.childElementCount > 0)).toEqual([true, true, true]);

    await reopen(container);

    // After the open: three slots, and only the current app's has anything in it.
    expect(get(currentApp).id).toBe('contacts');
    expect(slots(container).map((s) => s.childElementCount > 0)).toEqual([false, false, true]);

    openApp('calculator');
    flushSync();
    expect(slots(container).map((s) => s.childElementCount > 0)).toEqual([true, false, true]);

    // And the one nobody switched to mounts once the intro has had its frames.
    await waitFor(
      () =>
        expect(slots(container).map((s) => s.childElementCount > 0)).toEqual([true, true, true]),
      { timeout: RESIDENT_MOUNT_DELAY_MS * 4 }
    );
  });

  it("registers a background app's search provider and Control Center tile once the deferral ends", async () => {
    const { container } = await renderOpen();
    openApp(PROBE);
    flushSync();
    expect(probeTileUp()).toBe(true);
    openApp('calculator');
    flushSync();

    await reopen(container);
    // The probe is resident but behind Calculator: not built yet, so nothing registered.
    expect(get(runningApps).map((a) => a.id)).toContain(PROBE);
    expect(probeTileUp()).toBe(false);

    await waitFor(() => expect(probeTileUp()).toBe(true), {
      timeout: RESIDENT_MOUNT_DELAY_MS * 4
    });
    searchQuery.set('grocery');
    flushSync();
    expect(probeAnswered()).toBe(true);
  });

  it('registers them at once if search opens before the intro is over', async () => {
    const { container } = await renderOpen();
    openApp(PROBE);
    flushSync();
    goHome();
    flushSync();

    await reopen(container);
    expect(probeTileUp()).toBe(false);

    openDrawer();
    searchQuery.set('grocery');
    flushSync();
    expect(probeTileUp()).toBe(true);
    expect(probeAnswered()).toBe(true);
  });

  it('registers them at once if the Control Center opens before the intro is over', async () => {
    const { container } = await renderOpen();
    openApp(PROBE);
    flushSync();
    goHome();
    flushSync();

    await reopen(container);
    expect(probeTileUp()).toBe(false);

    openControlCenter();
    flushSync();
    expect(probeTileUp()).toBe(true);
  });
});

describe("Shell asks for an app's host once, not on every pass (MICA-375)", () => {
  const asksFor = (appId: string) =>
    vi.mocked(hostForApp).mock.calls.filter(([id]) => id === appId).length;

  beforeAll(async () => {
    for (const id of ['calculator', 'contacts']) await appRegistryStore.loadComponent(id, 'phone');
  }, 60_000);

  afterEach(() => {
    cleanup();
    closeAllApps();
    openDevice.set(null);
  });

  it('asks once for a resident app however often the player switches', async () => {
    await renderOpen();
    vi.mocked(hostForApp).mockClear();

    openApp('calculator');
    flushSync();
    for (let i = 0; i < 5; i++) {
      goHome();
      flushSync();
      openApp('contacts');
      flushSync();
      openApp('calculator');
      flushSync();
    }
    expect(asksFor('calculator')).toBe(1);
    expect(asksFor('contacts')).toBe(1);
  });

  it('asks again when the app comes back with a different manifest', async () => {
    await renderOpen();
    openApp(PROBE);
    flushSync();
    vi.mocked(hostForApp).mockClear();

    // A reinstall: a new manifest object under the same id, which may declare other
    // permissions — the one case where the remembered host can be the wrong one.
    appRegistryStore.registerApp(
      {
        id: PROBE,
        name: 'Resident Probe',
        tile: { bg: 'bg-gray-800' },
        core: true
      } as unknown as AppManifest,
      ResidentProbe
    );
    goHome();
    flushSync();
    openApp(PROBE);
    flushSync();
    expect(asksFor(PROBE)).toBe(1);
  });
});
