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

/**
 * Tailwind background utilities that would occlude the game world.
 *
 * `surface*` is in the list because of how nearly this test stopped working. The
 * original pattern named only raw palette families, so when the phone moved to M3
 * colour roles a `bg-surface` on the screen — the obvious thing to reach for, and an
 * opaque colour — matched nothing here. The suite would have stayed green while the
 * viewfinder went black in game, which is the precise failure this file exists to
 * catch. A role token is opaque like any other fill; the naming scheme changed, the
 * hazard did not.
 */
const OPAQUE_BG = /(^|\s)bg-(gray|black|white|slate|zinc|neutral|stone|surface)[\w-]*(\s|$)/;

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

    // The screen's fill is the wallpaper, which is a class for a preset and an inline
    // `background:` for a picked colour or a photo — so assert the *intent* rather than
    // one of the two shapes. The previous assertion looked for `bg-gray-900|gradient`
    // and was passing on the `gradient` half by coincidence: the `bg-gray-900` branch
    // beside it could never apply, and the default wallpaper simply happens to be a
    // gradient. Change the default to a solid colour and it would have failed for a
    // reason that had nothing to do with anything being wrong.
    const screen = getByTestId('phone-screen');
    const painted =
      /(^|\s)bg-gradient|(^|\s)bg-\w/.test(screen.className) ||
      /background:/.test(screen.getAttribute('style') ?? '');
    expect(painted, 'phone-screen has no wallpaper fill').toBe(true);
  });

  it('keeps a digit-free accessible name on the status bar', () => {
    // Load-bearing for the e2e suite, which is not obvious from here.
    //
    // The status bar is a `<button>` displaying the clock and the battery percentage,
    // and it precedes every app in the DOM. Several e2e specs click keypad digits, and
    // when they addressed them by *text* the status bar won — so `phone.spec.ts` failed
    // for any time containing a 5 or a 9, and `keybinds.spec.ts` for a 7 or an 8. Those
    // specs now use `getByRole(name:)`, which reads the accessible name, and this label
    // is the only reason that distinguishes the two.
    //
    // Delete or templatise this label and the flake comes back, in specs that do not
    // mention this file. Hence the assertion here rather than a comment there.
    const bar = renderFrame(false).getByRole('button', { name: /notification shade/i });
    const label = bar.getAttribute('aria-label') ?? '';
    expect(label).not.toMatch(/\d/);
    expect(bar.textContent ?? '').toMatch(/\d/); // the digits are still on screen
  });

  it('writes the theme onto the screen', () => {
    // The screen is the theme root: these custom properties inherit from here into every
    // app, so an app writing `bg-surface-container` resolves against whatever the player
    // seeded. Nothing else in the suite would notice if they stopped being emitted —
    // every utility would silently fall back to the shipped literal in `app.css`.
    const style = renderFrame(false).getByTestId('phone-screen').getAttribute('style') ?? '';
    expect(style).toContain('--color-surface:');
    expect(style).toContain('--color-on-surface:');
  });

  it('writes the theme but not the wallpaper when transparent', () => {
    // The wallpaper is withheld so the game world shows through, but the UI drawn over
    // it still has to be themed. These two travel on the same attribute, so it is worth
    // asserting that suppressing one does not take the other with it.
    const style = renderFrame(true).getByTestId('phone-screen').getAttribute('style') ?? '';
    expect(style).toContain('--color-surface:');
    expect(style).not.toContain('background:');
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
    const { getByRole, findByRole } = renderFrame(false);
    const { openShade, isShadeOpen } = await import('./state/shade');
    const { get } = await import('svelte/store');
    const { fireEvent } = await import('@testing-library/svelte');

    openShade();
    expect(get(isShadeOpen)).toBe(true);

    // The label names the action the press will perform, so with the shade open the bar
    // announces itself as "Collapse notifications" rather than as home. Looking it up by
    // that name is also what asserts the label actually tracks the state — a static
    // label would fail here rather than quietly describing the wrong thing.
    // `findByRole`, not `getByRole`: `openShade()` is a direct store write from outside
    // the component, so Svelte has not flushed the re-render yet and the synchronous
    // query would read the pre-open label.
    const homeBar = await findByRole('button', { name: /Collapse notifications/i });
    await fireEvent.click(homeBar);

    expect(get(isShadeOpen)).toBe(false);
    expect(getByRole('button', { name: /Return to home screen/i })).toBeTruthy();
  });
});
