// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import AppDrawer from './AppDrawer.svelte';
import { isAdmin } from '../services/admin';
import {
  openDrawer,
  closeDrawer,
  isDrawerOpen,
  drawerDragPhase,
  drawerDragProgress,
  searchQuery
} from './state/appDrawer';
import { get } from 'svelte/store';

const type = async (text: string) => {
  const input = screen.getByLabelText('Search apps, contacts and messages');
  await fireEvent.input(input, { target: { value: text } });
};

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
  });
}

const names = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].map((b) => (b.textContent || '').trim());

beforeEach(() => {
  isAdmin.set(true);
  closeDrawer();
  searchQuery.set('');
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

  it('does not stay stuck open after a full-distance swipe is closed by a tap (MICA-45)', async () => {
    // An overshoot swipe-open already has `drawerDragProgress` sitting at its commit
    // target (1) by the time `'settling'` begins — the live drag itself already got
    // there. Reproduced directly rather than by dispatching real pointer events: what
    // matters here is the state combination (`isDrawerOpen` true, phase `'settling'`,
    // progress already at 1), not how a real swipe happens to arrive at it.
    openDrawer();
    drawerDragProgress.set(1);
    drawerDragPhase.set('settling');

    const { getByTestId } = render(AppDrawer, { props: { openApp: () => {} } });

    // A tap on the top pill closes the drawer but never touches the drag phase — same
    // as the scrim's own `onclick={closeDrawer}`. With `drawerDragProgress` already at
    // its target, the sheet's `transform` never changes, so no `transitionend` fires to
    // flip `'settling'` back to `'idle'` on its own.
    await fireEvent.click(getByTestId('drawer-top-handle'));
    expect(get(isDrawerOpen)).toBe(false);

    // Without the fallback timer this stays stuck at `'settling'` forever —
    // `$isDrawerOpen || $drawerDragPhase !== 'idle'` stays true, so the scrim and its
    // blur never leave the screen. A real wait, not fake timers: the outro transition
    // this unmount goes through isn't driven by `setTimeout` in a way fake timers can
    // fast-forward.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(get(drawerDragPhase)).toBe('idle');
  }, 10000);

  it('abandons a handle drag torn down mid-flight rather than pinning the sheet open (MICA-106)', async () => {
    openDrawer();
    const { getByTestId, unmount } = render(AppDrawer, { props: { openApp: () => {} } });

    // A real drag rather than a tap: past `attachDragGesture`'s 4px axis threshold, which
    // is what commits the gesture and writes `'dragging'`.
    const handle = getByTestId('drawer-top-handle');
    await fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    await fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 140 });
    expect(get(drawerDragPhase)).toBe('dragging');

    // The effect that attached the gesture tears it down — the `{#if}` re-created the
    // handle, or the drawer unmounted. The listeners that would have ended this drag are
    // on `window` and go with it, so the finger's eventual `pointerup` reaches nothing.
    unmount();

    // `'dragging'` is the phase with no way back: the 250ms fallback above only covers
    // `'settling'`, and `{#if $isDrawerOpen || $drawerDragPhase !== 'idle'}` keeps the
    // sheet mounted and visible for as long as it holds. Left stuck, that is the drawer
    // sitting open over the phone for the rest of the session.
    expect(get(drawerDragPhase)).toBe('idle');
  });

  it('shows the app grid when the query is empty, a filtered list once typing starts', async () => {
    openDrawer();
    render(AppDrawer, { props: { openApp: () => {} } });

    await type('camer');

    expect(screen.getByText('Apps')).toBeTruthy();
    expect(screen.getByText('Camera')).toBeTruthy();
  });

  it('says so when nothing matches', async () => {
    openDrawer();
    render(AppDrawer, { props: { openApp: () => {} } });

    await type('zzzznope');

    expect(screen.getByText(/No results for/)).toBeTruthy();
  });

  it('opening a search result closes the drawer and clears the query', async () => {
    openDrawer();
    const openApp = vi.fn();
    render(AppDrawer, { props: { openApp } });
    await type('camer');

    await fireEvent.click(screen.getByText('Camera'));

    expect(openApp).toHaveBeenCalledWith('camera');
    expect(get(isDrawerOpen)).toBe(false);
    expect(get(searchQuery)).toBe('');
  });

  it('focuses the search input whenever it opens, however it opened', async () => {
    openDrawer();
    render(AppDrawer, { props: { openApp: () => {} } });

    expect(screen.getByLabelText('Search apps, contacts and messages')).toBe(
      document.activeElement
    );
  });

  it('depends on Contacts and Messages preloading their stores at boot', async () => {
    // Search reads those two stores and never fetches for itself. Both apps declare a
    // `preload` that `bootstrapStores` runs when the phone opens, which is what puts data
    // there before the home screen paints.
    const [contactsManifest, messagesManifest] = await Promise.all([
      import('../apps/contacts/manifest'),
      import('../apps/messages/manifest')
    ]);

    expect(contactsManifest.default.preload).toBeTypeOf('function');
    expect(messagesManifest.default.preload).toBeTypeOf('function');
  });
});
