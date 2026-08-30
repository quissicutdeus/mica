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
