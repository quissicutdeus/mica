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
import { isAnySheetOpen, anySheetOpen } from './sheets';
import { isShadeOpen } from './shade';
import { isDrawerOpen } from './appDrawer';

/**
 * MICA-140. The notification shade and the app drawer are mutually exclusive by design —
 * each is the whole screen, each registers its own `back` handler, and each has a close
 * gesture that assumes it is the thing on top. Four separate gestures can open one, and
 * they had each written that rule out by hand with a different subset of it.
 */
describe('isAnySheetOpen', () => {
  beforeEach(() => {
    isShadeOpen.set(false);
    isDrawerOpen.set(false);
  });

  it('is false only when neither sheet is open', () => {
    expect(get(isAnySheetOpen)).toBe(false);
    expect(anySheetOpen()).toBe(false);
  });

  it('is true for the shade alone', () => {
    isShadeOpen.set(true);
    expect(anySheetOpen()).toBe(true);
  });

  it('is true for the drawer alone — the half the status bar was missing', () => {
    isDrawerOpen.set(true);
    expect(anySheetOpen()).toBe(true);
  });

  it('tracks changes rather than sampling once', () => {
    isDrawerOpen.set(true);
    expect(anySheetOpen()).toBe(true);
    isDrawerOpen.set(false);
    expect(anySheetOpen()).toBe(false);
  });
});
