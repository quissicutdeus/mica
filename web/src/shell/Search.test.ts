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
import { render, fireEvent, screen } from '@testing-library/svelte';
import { get } from 'svelte/store';
import Search from './Search.svelte';
import { closeDrawer, isDrawerOpen } from './state/appDrawer';
// The reveal distance is the frame's height, and this renders on the phone (MICA-259).
import { PHONE_HEIGHT as SHADE_DRAG_REVEAL_DISTANCE } from './state/display';

if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

beforeEach(() => {
  closeDrawer();
});

const fire = (target: EventTarget, type: string, clientY: number, timeMs: number) => {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 0,
    clientY,
    pointerId: 1,
    button: 0
  });
  Object.defineProperty(event, 'timeStamp', { value: timeMs, configurable: true });
  target.dispatchEvent(event);
};

describe('Search (collapsed bar)', () => {
  it('opens the drawer when tapped', async () => {
    render(Search);

    await fireEvent.click(screen.getByLabelText('Search'));

    expect(get(isDrawerOpen)).toBe(true);
  });

  it('hides itself while the drawer is open', async () => {
    render(Search);
    await fireEvent.click(screen.getByLabelText('Search'));

    expect(screen.queryByLabelText('Search')).toBeNull();
  });

  it('opens the app drawer on a swipe-up starting on the collapsed bar, not just a tap (MICA-45)', async () => {
    // Same defect as the home indicator bar: the collapsed bar is a sibling of the Dock,
    // not a descendant, so a swipe starting here never reached the Dock's own gesture.
    render(Search);
    const bar = screen.getByLabelText('Search');

    const commitDeltaY = -(SHADE_DRAG_REVEAL_DISTANCE * 0.6);
    fire(bar, 'pointerdown', 0, 0);
    fire(window, 'pointermove', commitDeltaY, 20);
    fire(window, 'pointerup', commitDeltaY, 20);

    expect(get(isDrawerOpen)).toBe(true);

    // Consume the swallow-once `click` listener a real drag release leaves on `window`
    // (jsdom never synthesizes it the way a real touch release would).
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
});
