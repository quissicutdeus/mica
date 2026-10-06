// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../host/registerFacets';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { get } from 'svelte/store';
import Home from './Launcher.svelte';
import { isAdmin } from '../services/admin';
import { homeEditMode, homeGridItems, openFolderId } from './state/homeGrid';
import { homeGridColumns, homeGridRows } from './state/homeGridSettings';

/**
 * The launcher is now the configurable home grid only — every installed app used to
 * render here unconditionally, but that surface moved to `AppDrawer.svelte`
 * (`AppDrawer.test.ts` carries the admin-visibility assertions this file used to have).
 * The grid itself starts empty; only what a player has explicitly placed shows up.
 */

if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

beforeEach(() => {
  isAdmin.set(true);
  homeGridItems.set([]);
  homeGridColumns.set(4);
  homeGridRows.set(5);
  openFolderId.set(null);
});

const names = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].map((b) => (b.textContent || '').trim());

describe('home launcher (grid)', () => {
  it('renders an empty grid by default, with placeholder cells and zero app buttons', () => {
    const { container } = render(Home, { props: { openApp: () => {} } });
    expect(container.querySelectorAll('[data-position]')).toHaveLength(20); // 4 x 5
    expect(names(container)).toEqual([]);
  });

  it('renders a placed app at its cell', () => {
    homeGridItems.set([{ position: 3, kind: 'app', appId: 'contacts' }]);
    const { container } = render(Home, { props: { openApp: () => {} } });
    const cell = container.querySelector('[data-position="3"]');
    expect(cell?.querySelector('button')).not.toBeNull();
    expect(names(container).some((n) => n.includes('Contacts'))).toBe(true);
  });

  it('tapping a placed app opens it', async () => {
    homeGridItems.set([{ position: 3, kind: 'app', appId: 'contacts' }]);
    const openApp = vi.fn();
    const { getByText } = render(Home, { props: { openApp } });
    await fireEvent.click(getByText('Contacts'));
    expect(openApp).toHaveBeenCalledWith('contacts');
  });

  it('hides a placed admin app from a non-admin, but still shows an ordinary placed app', () => {
    isAdmin.set(false);
    homeGridItems.set([
      { position: 0, kind: 'app', appId: 'admin' },
      { position: 1, kind: 'app', appId: 'contacts' }
    ]);
    const { container } = render(Home, { props: { openApp: () => {} } });
    expect(names(container).some((n) => n.includes('Admin'))).toBe(false);
    expect(names(container).some((n) => n.includes('Contacts'))).toBe(true);
  });

  it('renders a folder tile and opens the popup on tap', async () => {
    homeGridItems.set([
      { position: 2, kind: 'folder', folderId: 'f1', name: 'Work', appIds: ['contacts', 'mail'] }
    ]);
    const { getByLabelText } = render(Home, { props: { openApp: () => {} } });
    await fireEvent.click(getByLabelText('Work'));
    expect(get(openFolderId)).toBe('f1');
  });

  it('respects a resized grid', () => {
    homeGridColumns.set(3);
    homeGridRows.set(4);
    const { container } = render(Home, { props: { openApp: () => {} } });
    expect(container.querySelectorAll('[data-position]')).toHaveLength(12);
  });
});

describe('home launcher widgets (MICA-245)', () => {
  it('draws a widget over its footprint and not the cells beneath it', () => {
    homeGridItems.set([{ position: 1, kind: 'widget', widgetId: 'shell.clock', size: '2x2' }]);
    const { container } = render(Home, { props: { openApp: () => {} } });
    for (const p of [2, 5, 6]) expect(container.querySelector(`[data-position="${p}"]`)).toBeNull();
    expect(container.querySelector('[data-position="1"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-position]')).toHaveLength(20 - 3);
  });

  it('an app id that no longer exists draws nothing: no icon, no button, no empty tile', () => {
    // MICA-311: a dev add-on loaded with `?addonDev=` is gone after a reload without it.
    // The loader never places one on the grid, but an author can drag one there by hand,
    // and the cell must not survive as a broken icon.
    const item = { position: 2, kind: 'app', appId: 'gone-dev-addon' } as const;
    homeGridItems.set([item]);
    const { container } = render(Home, { props: { openApp: () => {} } });
    const cell = container.querySelector('[data-position="2"]');
    expect(cell).not.toBeNull();
    expect(cell?.children).toHaveLength(0);
    expect(names(container)).toEqual([]);
  });

  it('an unknown widget draws nothing but stays in the layout', () => {
    const item = { position: 0, kind: 'widget', widgetId: 'gone-app', size: '2x1' } as const;
    homeGridItems.set([item]);
    const { container } = render(Home, { props: { openApp: () => {} } });
    expect(container.querySelector('[data-testid="home-widget"]')).toBeNull();
    expect(get(homeGridItems)).toEqual([item]);
  });

  it('a long press on an empty cell enters edit mode, which offers Add widget and Done', async () => {
    vi.useFakeTimers();
    try {
      homeEditMode.set(false);
      const { container, queryByText } = render(Home, { props: { openApp: () => {} } });
      const cell = container.querySelector('[data-position="7"]') as HTMLElement;
      await fireEvent.pointerDown(cell, { pointerId: 1, clientX: 5, clientY: 5 });
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      expect(get(homeEditMode)).toBe(true);
      await fireEvent.pointerUp(window, { pointerId: 1 });
      expect(queryByText('Add widget')).not.toBeNull();
      expect(queryByText('Done')).not.toBeNull();
    } finally {
      homeEditMode.set(false);
      vi.useRealTimers();
    }
  });
});
