import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import PhoneFrame from './PhoneFrame.svelte';
import { charge } from './state/charge';

/**
 * In game the phone is a transparent NUI overlay: the camera viewfinder is the actual
 * world showing through it. Any opaque background **anywhere in the ancestor chain**
 * turns that into a black rectangle.
 *
 * That is exactly how it shipped. `transparent` was applied to the inner screen div
 * while the outer frame kept an unconditional `bg-gray-950`, so the screen was
 * see-through onto a near-black parent and the viewfinder was black no matter what.
 * The bug is invisible in a browser, where the camera module paints its own mock
 * backdrop.
 *
 * These assertions are about the whole chain, not one element, because a single
 * element being right is what made the original bug so easy to miss.
 */

/** Tailwind background utilities that would occlude the game world. */
const OPAQUE_BG = /(^|\s)bg-(gray|black|white|slate|zinc|neutral|stone)-?\d*(\s|$)/;

// jsdom has no Web Animations API and Svelte's `transition:fly` calls it on mount.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    startTime: 0,
    currentTime: 0,
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  }) as unknown as Element['animate'];
}

const noopSnippet = (() => {}) as never;

const renderFrame = (transparent: boolean) =>
  render(PhoneFrame, {
    props: { transparent, onClose: () => {}, children: noopSnippet }
  });

describe('PhoneFrame transparency', () => {
  beforeEach(() => {
    // A dead phone deliberately paints black; keep it alive for these cases.
    charge.set(100);
  });

  it('leaves no opaque background in the chain when transparent', () => {
    const { getByTestId } = renderFrame(true);

    for (const id of ['phone-frame', 'phone-screen']) {
      const el = getByTestId(id);
      expect(el.className, `${id} would occlude the game world`).not.toMatch(OPAQUE_BG);
    }
  });

  it('keeps the bezel border even when transparent', () => {
    // The border is the phone body, not the display — dropping it with the fill would
    // leave the UI floating with no visible edge.
    const { getByTestId } = renderFrame(true);
    expect(getByTestId('phone-frame').className).toMatch(/border-gray-950/);
  });

  it('is opaque as normal when not transparent', () => {
    const { getByTestId } = renderFrame(false);
    expect(getByTestId('phone-frame').className).toMatch(/bg-gray-950/);
    expect(getByTestId('phone-screen').className).toMatch(/bg-gray-900/);
  });

  it('stays opaque when the battery is dead, even if transparent was asked for', () => {
    // The dead screen is a black slab by design; letting the world through it would
    // read as the phone still being on.
    charge.set(0);
    const { getByTestId } = renderFrame(true);
    expect(getByTestId('phone-frame').className).toMatch(/bg-gray-950/);
    expect(getByTestId('phone-screen').className).toMatch(/bg-black/);
  });

  it('closes notification shade when open on clicking home gesture bar', async () => {
    const { getByRole } = renderFrame(false);
    const { openShade, isShadeOpen } = await import('./state/shade');
    const { get } = await import('svelte/store');
    const { fireEvent } = await import('@testing-library/svelte');

    openShade();
    expect(get(isShadeOpen)).toBe(true);

    const homeBar = getByRole('button', {
      name: /Return to home screen or collapse notifications/i
    });
    await fireEvent.click(homeBar);

    expect(get(isShadeOpen)).toBe(false);
  });
});
