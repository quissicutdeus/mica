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
import { tick } from 'svelte';
import { get } from 'svelte/store';
import Home from './Launcher.svelte';
import { isAdmin } from '../services/admin';
import { homeEditMode, homeGridItems, openFolderId } from './state/homeGrid';
import { homeGridColumns, homeGridRows } from './state/homeGridSettings';
import { activeHandlerFor, isTypingTarget, registerHandler } from './state/keybinds';

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

/**
 * The add-widget sheet says `role="dialog"` and `aria-modal`, so it has to behave like one
 * (MICA-410): Tab stays inside it, as in `FolderPopup` and the control center, and opening it
 * moves focus in. Focus lands on the sheet itself, never on a field — no keybind fires while a
 * text field has focus, and Back has to reach the shell exactly as it did before.
 */
describe('the add-widget sheet (MICA-410)', () => {
  beforeEach(() => homeEditMode.set(true));

  const openSheet = async () => {
    const view = render(Home, { props: { openApp: () => {} } });
    const opener = view.getByRole('button', { name: 'Add widget' });
    opener.focus();
    await fireEvent.click(opener);
    await tick();
    return { ...view, opener, sheet: view.getByRole('dialog', { name: 'Add widget' }) };
  };

  it('takes focus on open, on the sheet rather than a field, so Back still fires', async () => {
    const { sheet } = await openSheet();

    expect(document.activeElement).toBe(sheet);
    expect(isTypingTarget(document.activeElement)).toBe(false);
  });

  it('keeps Tab inside the sheet, wrapping both ways', async () => {
    const { sheet } = await openSheet();
    const buttons = [...sheet.querySelectorAll('button')];
    const first = buttons[0];
    const last = buttons[buttons.length - 1];

    last.focus();
    // `fireEvent` answers false when the event was cancelled: the trap took the Tab.
    expect(await fireEvent.keyDown(last, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(first);

    expect(await fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it('closes on Back, above the shell, and hands Back back once it is shut', async () => {
    // Stands in for `Shell.svelte`'s fallback, which on home lowers the phone. The sheet is
    // a level above it: Back closes the sheet, and only the next Back reaches the shell.
    const shellBack = vi.fn();
    const release = registerHandler('back', shellBack);
    try {
      const { queryByRole } = await openSheet();

      activeHandlerFor('back')?.();
      await tick();

      expect(queryByRole('dialog', { name: 'Add widget' })).toBeNull();
      expect(shellBack).not.toHaveBeenCalled();
      expect(activeHandlerFor('back')).toBe(shellBack);
    } finally {
      release();
    }
  });

  it('hands focus back to Add widget when it closes', async () => {
    const { sheet, opener, getByRole } = await openSheet();
    const buttons = [...sheet.querySelectorAll('button')];
    const done = buttons[buttons.length - 1];
    done.focus();

    await fireEvent.click(done);
    await tick();

    expect(() => getByRole('dialog', { name: 'Add widget' })).toThrow();
    expect(document.activeElement).toBe(opener);
  });
});
