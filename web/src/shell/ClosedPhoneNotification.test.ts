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
import ClosedPhoneNotification from './ClosedPhoneNotification.svelte';
import { closedPhoneToast } from './state/toast';
import { isPhoneOpen } from './state/phoneOpen';

// jsdom has no Web Animations API and this component's `transition:fly` calls it on mount.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    startTime: 0,
    currentTime: 0,
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

describe('ClosedPhoneNotification (MICA-141)', () => {
  beforeEach(() => {
    closedPhoneToast.set(null);
    isPhoneOpen.set(false);
  });

  it('renders nothing when no closed-phone toast is pending', () => {
    const { queryByTestId } = render(ClosedPhoneNotification);
    expect(queryByTestId('closed-phone-notification')).toBeNull();
  });

  it('shows the peek card with the pending toast’s title and message', () => {
    closedPhoneToast.set({
      id: 'x',
      title: 'Blabber',
      message: '@you were mentioned',
      type: 'info'
    });

    const { getByTestId, getByText } = render(ClosedPhoneNotification);
    expect(getByTestId('closed-phone-notification')).toBeTruthy();
    expect(getByText('@you were mentioned')).toBeTruthy();
    expect(getByText('Blabber')).toBeTruthy();
  });

  it('is non-interactive — the whole point is a glance, not a second toast host', () => {
    closedPhoneToast.set({ id: 'x', message: 'hi', type: 'info' });
    const { container } = render(ClosedPhoneNotification);

    expect(container.querySelector('button')).toBeNull();
    const root = container.querySelector('[data-testid="closed-phone-notification"]');
    expect(root?.className).toContain('pointer-events-none');
  });
});
