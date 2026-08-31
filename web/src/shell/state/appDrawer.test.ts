// @vitest-environment jsdom
// MICA-176: jsdom because this file's subject now transitively imports `services/admin.ts`,
// which reads `window` at module scope. Not a workaround for `isBrowser()` — see the commit
// message for why teaching that predicate to tolerate a missing `window` is the worse fix.
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../sdk/host/inProcess/registerFacets';
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  isDrawerOpen,
  openDrawer,
  closeDrawer,
  toggleDrawer,
  drawerDragProgress,
  drawerDragPhase,
  searchQuery
} from './appDrawer';
import { activeHandlerFor } from './keybinds';
import { iconDragState, startIconDrag } from './iconDrag';
import { appDrawerHintSeen } from './onboarding';

describe('App Drawer state', () => {
  beforeEach(() => {
    closeDrawer();
    drawerDragProgress.set(0);
    drawerDragPhase.set('idle');
    appDrawerHintSeen.set(false);
  });

  it('defaults to closed', () => {
    expect(get(isDrawerOpen)).toBe(false);
  });

  it('opens and closes', () => {
    openDrawer();
    expect(get(isDrawerOpen)).toBe(true);
    closeDrawer();
    expect(get(isDrawerOpen)).toBe(false);
  });

  it('marks the swipe-up hint seen on first open, and stays seen after close/reopen', () => {
    expect(get(appDrawerHintSeen)).toBe(false);
    openDrawer();
    expect(get(appDrawerHintSeen)).toBe(true);
    closeDrawer();
    openDrawer();
    expect(get(appDrawerHintSeen)).toBe(true);
  });

  it('toggles', () => {
    toggleDrawer();
    expect(get(isDrawerOpen)).toBe(true);
    toggleDrawer();
    expect(get(isDrawerOpen)).toBe(false);
  });

  it('reclaims the back keybind while open and releases it when closed', () => {
    openDrawer();
    const handler = activeHandlerFor('back');
    expect(handler).toBeDefined();
    handler!();
    expect(get(isDrawerOpen)).toBe(false);
  });

  it('drag progress/phase are independently mutable with no side effect on isDrawerOpen', () => {
    drawerDragProgress.set(0.5);
    drawerDragPhase.set('dragging');
    expect(get(isDrawerOpen)).toBe(false);
    expect(activeHandlerFor('back')).toBeUndefined();
  });

  it('closing the drawer clears any in-flight icon drag', () => {
    openDrawer();
    startIconDrag('notes', { kind: 'drawer' }, 10, 20);
    expect(get(iconDragState).appId).toBe('notes');

    closeDrawer();
    expect(get(iconDragState).appId).toBeNull();
  });

  it('closing clears the search query', () => {
    searchQuery.set('camer');
    openDrawer();

    closeDrawer();

    expect(get(searchQuery)).toBe('');
  });
});
