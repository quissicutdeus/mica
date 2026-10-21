// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/svelte';

// jsdom has no `Element.animate`, and the dialog fades in through `lib/motion`. The stub is
// `RecentlyDeleted.test.ts`'s, which resolves `onfinish` the way a real animation would.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn(function mockAnimate() {
    let onfinish: (() => void) | null = null;
    queueMicrotask(() => onfinish?.());
    return {
      cancel: () => {},
      finish: () => {},
      startTime: 0,
      currentTime: 0,
      effect: { getComputedTiming: () => ({ duration: 0 }) },
      set onfinish(fn: (() => void) | null) {
        onfinish = fn;
      },
      get onfinish() {
        return onfinish;
      }
    };
  }) as unknown as typeof Element.prototype.animate;
}

import ConfirmDialog from './ConfirmDialog.svelte';

/**
 * MICA-406. The dialog opens over a screen whose own title is an `h1`, so its heading is an
 * `h2`, as every sdk/ui dialog's is; an `h3` there is axe's `heading-order`. The dialog keeps
 * its name from `aria-label`, the caller's `title`.
 */
describe('ConfirmDialog heading', () => {
  it('is a level-2 heading inside a dialog named by the same words', () => {
    const { getByRole, container } = render(ConfirmDialog, {
      title: 'Uninstall Notes',
      message: 'Its data stays on the server.',
      onconfirm: () => {},
      oncancel: () => {}
    });
    expect(getByRole('dialog', { name: 'Uninstall Notes' }).getAttribute('aria-modal')).toBe(
      'true'
    );
    expect(getByRole('heading', { level: 2, name: 'Uninstall Notes' })).toBeTruthy();
    expect(container.querySelector('h3')).toBeNull();
  });
});
