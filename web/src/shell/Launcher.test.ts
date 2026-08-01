import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import Home from './Launcher.svelte';
import { isAdmin } from '../services/admin';

/**
 * The launcher hides `requiresAdmin` apps from everyone else.
 *
 * Tested here rather than in e2e because a browser has no ace list and stands in as
 * admin, so the filter is a no-op there and an e2e passes whether it exists or not.
 * That is exactly the vacuous-pass shape worth avoiding.
 *
 * This is the launcher only. Hiding an icon is not a permission — the report queue and
 * every resolve action are gated again server-side.
 */

if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  }) as unknown as Element['animate'];
}

const names = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].map((b) => (b.textContent || '').trim());

beforeEach(() => isAdmin.set(true));

describe('home launcher', () => {
  it('shows the Admin app to an admin', () => {
    const { container } = render(Home, { props: { openApp: () => {} } });
    expect(names(container).some((n) => n.includes('Admin'))).toBe(true);
  });

  it('hides it from everyone else', () => {
    isAdmin.set(false);
    const { container } = render(Home, { props: { openApp: () => {} } });
    expect(names(container).some((n) => n.includes('Admin'))).toBe(false);
  });

  it('still shows ordinary apps to a non-admin', () => {
    // Guards against the filter being too broad and emptying the launcher.
    isAdmin.set(false);
    const { container } = render(Home, { props: { openApp: () => {} } });
    expect(names(container).some((n) => n.includes('Settings'))).toBe(true);
  });
});
