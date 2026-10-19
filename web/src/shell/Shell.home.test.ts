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
import { closeAllApps, currentApp, goHome, openApp } from './state/navigation';
import { appRegistryStore } from './state/registry';
import { openDevice } from './state/phoneOpen';
import { isLocked } from './state/lockScreen';
import { closeDrawer, isDrawerOpen, openDrawer } from './state/appDrawer';
import { openFolderId } from './state/homeGrid';
import { activeHandlerFor } from './state/keybinds';

/** No Web Animations in jsdom; the frame's fly-in finishes at once, as in `Shell.test.ts`. */
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

const renderOpen = async () => {
  const view = render(Shell);
  await waitFor(() => expect(get(isLocked)).toBe(false));
  await waitFor(() => expect(view.container.querySelector('main')).not.toBeNull());
  return view;
};

const homeLayer = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="home-layer"]');

/**
 * Svelte sets `inert` as a property where the element has one, and jsdom keeps it there
 * without reflecting it to the attribute a browser would show. Either counts.
 */
const isInert = (el: HTMLElement | null) => !!el && (el.inert === true || el.hasAttribute('inert'));

/** The launcher's own root — the node whose identity says whether Home was rebuilt. */
const homeScreen = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[role="region"][aria-label="Home Screen"]');

/** What `Back` does right now, with the app on screen as the dispatcher would see it. */
const pressBack = () => {
  const handler = activeHandlerFor('back', get(currentApp).id);
  expect(handler).toBeDefined();
  handler?.();
  flushSync();
};

describe('Home stays mounted under an open app (MICA-363)', () => {
  beforeAll(async () => {
    // Warm the chunk, so the first test is about mounting and not a cold import.
    await appRegistryStore.loadComponent('calculator', 'phone');
  }, 60_000);

  afterEach(() => {
    cleanup();
    closeDrawer();
    openFolderId.set(null);
    closeAllApps();
    openDevice.set(null);
  });

  it('keeps the same Home instance across an app open and close', async () => {
    const { container } = await renderOpen();
    const before = homeScreen(container);
    expect(before).not.toBeNull();

    openApp('calculator');
    flushSync();
    // Still in the document while the app is up, not torn down.
    expect(homeScreen(container)).toBe(before);
    expect(before?.isConnected).toBe(true);

    goHome();
    flushSync();
    expect(homeScreen(container)).toBe(before);
  });

  it('hides the layer with visibility, opacity, pointer-events and inert — never display:none', async () => {
    const { container } = await renderOpen();
    const layer = homeLayer(container);
    expect(layer).not.toBeNull();

    // On home: none of it.
    for (const cls of ['invisible', 'opacity-0', 'pointer-events-none', 'hidden']) {
      expect(layer?.classList.contains(cls)).toBe(false);
    }
    expect(isInert(layer)).toBe(false);

    openApp('calculator');
    flushSync();
    for (const cls of ['invisible', 'opacity-0', 'pointer-events-none']) {
      expect(layer?.classList.contains(cls)).toBe(true);
    }
    expect(layer?.classList.contains('hidden')).toBe(false);
    expect(isInert(layer)).toBe(true);
    expect(layer?.getAttribute('aria-hidden')).toBeNull();

    goHome();
    flushSync();
    expect(layer?.classList.contains('invisible')).toBe(false);
    expect(isInert(layer)).toBe(false);
  });

  it('is not counted as a resident-app slot', async () => {
    const { container } = await renderOpen();
    const layer = homeLayer(container);
    // The slot shape `Shell.test.ts` and the residency specs select by.
    expect(layer?.matches('div.absolute.inset-0')).toBe(false);
  });

  it('closes the drawer on leaving home, so Back leaves the app instead of a hidden sheet', async () => {
    await renderOpen();
    openDrawer();
    flushSync();
    expect(get(isDrawerOpen)).toBe(true);

    openApp('calculator');
    flushSync();
    expect(get(isDrawerOpen)).toBe(false);

    pressBack();
    expect(get(currentApp).id).toBe('home');
  });

  it('closes an open folder on leaving home, so Back leaves the app instead of a hidden folder', async () => {
    await renderOpen();
    openFolderId.set('folder-under-test');
    flushSync();

    openApp('calculator');
    flushSync();
    expect(get(openFolderId)).toBeNull();

    pressBack();
    expect(get(currentApp).id).toBe('home');
  });

  it('leaves a drawer that is open on home alone', async () => {
    await renderOpen();
    openDrawer();
    flushSync();
    // Nothing left home, so nothing closes it: the reopen-with-drawer path relies on that.
    expect(get(isDrawerOpen)).toBe(true);
  });
});
