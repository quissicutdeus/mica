// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/svelte';
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
  }) as unknown as Element['animate'];
}

describe('ToastHost hit area', () => {
  beforeEach(() => {
    toast.clear();
  });

  it('renders nothing, and blocks nothing, when there are no toasts', () => {
    const { container } = render(ToastHost);
    expect(container.querySelector('[class*="pointer-events-none"]')).toBeNull();
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

  it('keeps every card independently interactive, with the stack still click-through, at the visible cap', () => {
    toast.show({ id: 'a', message: 'first', type: 'info', duration: 0 });
    toast.show({ id: 'b', message: 'second', type: 'info', duration: 0 });
    const { container } = render(ToastHost);

    const stack = container.querySelector('.pointer-events-none');
    expect(stack).not.toBeNull();
    expect(stack!.querySelectorAll('.pointer-events-auto').length).toBe(2);
  });
});
