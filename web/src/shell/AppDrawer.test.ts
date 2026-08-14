import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import AppDrawer from './AppDrawer.svelte';
import { isAdmin } from '../services/admin';
import { openDrawer, closeDrawer, isDrawerOpen } from './state/appDrawer';
import { get } from 'svelte/store';

/**
 * The drawer is now the "shows every installed app" surface — it absorbs the
 * admin-visibility assertions that used to live in Launcher.test.ts back when the launcher
 * itself showed everything. See homeGrid.ts/dock.ts's data-layer tests for the empty-by-
 * default home grid this replaced.
 */

if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  }) as unknown as Element['animate'];
}

const names = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].map((b) => (b.textContent || '').trim());

beforeEach(() => {
  isAdmin.set(true);
  closeDrawer();
});

describe('App Drawer', () => {
  it('renders nothing while closed', () => {
    const { container } = render(AppDrawer, { props: { openApp: () => {} } });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows every installed app, alphabetically, while open', () => {
    openDrawer();
    const { container } = render(AppDrawer, { props: { openApp: () => {} } });
    const shown = names(container).filter((n) => n.length > 0);
    expect(shown).toEqual([...shown].sort((a, b) => a.localeCompare(b)));
    expect(shown.length).toBeGreaterThan(1);
  });

  it('shows the Admin app to an admin', () => {
    openDrawer();
    const { container } = render(AppDrawer, { props: { openApp: () => {} } });
    expect(names(container).some((n) => n.includes('Admin'))).toBe(true);
  });

  it('hides the Admin app from a non-admin, but keeps ordinary apps visible', () => {
    isAdmin.set(false);
    openDrawer();
    const { container } = render(AppDrawer, { props: { openApp: () => {} } });
    expect(names(container).some((n) => n.includes('Admin'))).toBe(false);
    expect(names(container).some((n) => n.includes('Settings'))).toBe(true);
  });

  it('tapping an app opens it and closes the drawer', async () => {
    openDrawer();
    const openApp = vi.fn();
    const { getByText } = render(AppDrawer, { props: { openApp } });
    await fireEvent.click(getByText('Settings'));
    expect(openApp).toHaveBeenCalledWith('settings');
    expect(get(isDrawerOpen)).toBe(false);
  });
});
