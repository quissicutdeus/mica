import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { get } from 'svelte/store';
import Home from './Launcher.svelte';
import { isAdmin } from '../services/admin';
import { homeGridItems, openFolderId } from './state/homeGrid';
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
  }) as unknown as Element['animate'];
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
