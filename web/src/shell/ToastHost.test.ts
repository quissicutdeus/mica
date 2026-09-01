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
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import ToastHost from './ToastHost.svelte';
import { toast } from './state/toast';

/**
 * MICA-42: a toast sits directly over the top strip of whatever app is on screen, and
 * used to be pressable across its whole stack container — `top-12 right-3 left-3`, the
 * full width of the phone — rather than just the card itself. A tap aimed at an app
 * control under that strip landed on empty toast space instead.
 *
 * The stack container carries `pointer-events-none` and only each rendered card opts
 * back in with `pointer-events-auto`, so the only pressable area is ever the card's own
 * footprint — never the gaps around or between cards. These assertions are what would
 * catch a regression back to a blanket `pointer-events-auto` on the container.
 */

// jsdom has no Web Animations API and Svelte's `transition:fly` calls it on mount.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    startTime: 0,
    currentTime: 0,
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

describe('ToastHost hit area', () => {
  beforeEach(() => {
    toast.clear();
  });

  it('blocks nothing when there are no toasts', () => {
    const { container } = render(ToastHost);
    const stack = container.querySelector('.pointer-events-none');

    // The stack itself is now always mounted — it is the live region, and a live region
    // has to pre-date its contents to be announced (MICA-66). What MICA-42 is about is
    // unchanged and is asserted directly: nothing here is pressable, and there is no card.
    expect(stack).not.toBeNull();
    expect(stack!.querySelector('.pointer-events-auto')).toBeNull();
    expect(stack!.textContent?.trim()).toBe('');
  });

  it('keeps the stack container click-through and only the card itself interactive', () => {
    toast.show({ message: 'App installed successfully!', type: 'success', duration: 0 });
    const { container } = render(ToastHost);

    const stack = container.querySelector('.pointer-events-none');
    expect(stack, 'stack container must stay pointer-events-none').not.toBeNull();

    const card = stack!.querySelector('.pointer-events-auto');
    expect(card, 'the rendered card must opt back into pointer events').not.toBeNull();

    // The card is the only pointer-events-auto element inside the click-through stack —
    // nothing else (gaps, padding) is silently interactive too.
    expect(stack!.querySelectorAll('.pointer-events-auto').length).toBe(1);
  });

  it('renders only the one visible toast even when a second is queued behind it', () => {
    toast.show({ id: 'a', message: 'first', type: 'info', duration: 0 });
    toast.show({ id: 'b', message: 'second', type: 'info', duration: 0 });
    const { container } = render(ToastHost);

    const stack = container.querySelector('.pointer-events-none');
    expect(stack).not.toBeNull();
    // The queued second toast has no DOM presence at all until it becomes visible.
    expect(stack!.querySelectorAll('.pointer-events-auto').length).toBe(1);
  });

  it('updates the same card in place when the queue advances to the next toast, instead of remounting it', async () => {
    const idA = toast.show({ message: 'first', type: 'info', duration: 0 });
    toast.show({ message: 'second', type: 'info', duration: 0 }); // queued behind 'first'
    const { container } = render(ToastHost);

    const cardBefore = container.querySelector('.pointer-events-auto');
    expect(cardBefore).not.toBeNull();

    // Dismissing the visible toast advances the queue to 'second' in the same render
    // pass. The card must never remount here — a remount plays the outgoing card's exit
    // transition and the incoming card's entrance transition at the same time, which is
    // what visually "pushed down" the first toast when two arrived in quick succession.
    toast.dismiss(idA);
    await tick();

    const cardAfter = container.querySelector('.pointer-events-auto');
    expect(cardAfter).toBe(cardBefore);
    expect(cardAfter?.textContent).toContain('second');
  });
});

/**
 * MICA-66: a toast appears without focus moving, so without a live region a screen
 * reader is told nothing at all — the notification is a purely visual event.
 *
 * These assertions cover what jsdom can answer: that the region exists before there is
 * anything to announce, that it wraps the card rather than duplicating its text, and that
 * its politeness follows the kind of toast. Whether a given screen reader then speaks it
 * is the reader's own behaviour and is not testable here — nor is the ordering caveat in
 * `ToastHost.svelte` about `aria-live` being set in the same update as the card.
 */
describe('ToastHost announcements', () => {
  beforeEach(() => {
    toast.clear();
  });

  const region = (container: HTMLElement) => container.querySelector('[aria-live]');

  it('mounts the region before there is anything to announce', async () => {
    const { container } = render(ToastHost);
    await tick();

    expect(region(container)).not.toBeNull();
    expect(region(container)?.getAttribute('aria-live')).toBe('polite');
    expect(region(container)?.getAttribute('role')).toBe('status');
  });

  it('wraps the toast rather than repeating it, so the text is in the document once', async () => {
    const { container } = render(ToastHost);
    toast.show({ id: 'm1', type: 'message', sender: 'Ava', message: 'on my way', duration: 0 });
    await tick();

    const matches = [...container.querySelectorAll('*')].filter((el) =>
      [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.includes('on my way')
      )
    );
    expect(matches).toHaveLength(1);
    expect(region(container)?.contains(matches[0])).toBe(true);
  });

  it('interrupts for an incoming call, and waits its turn for anything else', async () => {
    const { container } = render(ToastHost);
    toast.show({ id: 'c1', type: 'call', title: 'Incoming call', message: 'Ava', duration: 0 });
    await tick();

    expect(region(container)?.getAttribute('aria-live')).toBe('assertive');
    expect(region(container)?.getAttribute('role')).toBe('alert');

    toast.dismiss('c1');
    toast.show({ id: 'm1', type: 'info', message: 'saved', duration: 0 });
    await tick();

    expect(region(container)?.getAttribute('aria-live')).toBe('polite');
  });

  it('is not atomic, so a re-render does not re-read the whole notification', async () => {
    const { container } = render(ToastHost);
    toast.show({ id: 'm1', type: 'info', message: 'first', duration: 0 });
    await tick();

    // With `aria-atomic="true"` every keystroke in a toast's reply box would read the
    // whole card aloud again, over the player typing into it.
    expect(region(container)?.hasAttribute('aria-atomic')).toBe(false);
  });
});
