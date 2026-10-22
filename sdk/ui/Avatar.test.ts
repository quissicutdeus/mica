// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import Avatar from './Avatar.svelte';

const root = (container: HTMLElement): HTMLElement => container.firstElementChild as HTMLElement;

/**
 * MICA-404. Three branches — a photo, a silhouette, initials — and the last is the one that
 * moved: initials are a pseudo-element's content, not a text node, so a button that wraps an
 * avatar keeps a name containing everything it visibly draws as text (axe-core's
 * `label-content-name-mismatch`, WCAG 2.5.3). `e2e/a11y.spec.ts` is what proves the rule
 * passes; these pin the markup that makes it pass.
 */
describe('Avatar', () => {
  it('draws initials as generated content, with no text node behind them', () => {
    const { container } = render(Avatar, { initials: 'AD', showSilhouette: false });
    expect(root(container).dataset.initials).toBe('AD');
    expect(container.textContent?.trim()).toBe('');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('draws the silhouette, and no initials, while showSilhouette holds', () => {
    const { container } = render(Avatar, { initials: 'AD' });
    expect(container.querySelector('svg')).not.toBeNull();
    expect(root(container).hasAttribute('data-initials')).toBe(false);
  });

  it('falls back to the silhouette when there are no initials to draw', () => {
    const { container } = render(Avatar, { showSilhouette: false });
    expect(container.querySelector('svg')).not.toBeNull();
    expect(root(container).hasAttribute('data-initials')).toBe(false);
  });

  it('names a photo by its initials, and by "Avatar" without them', () => {
    const named = render(Avatar, { src: 'https://x.test/a.png', initials: 'AD' });
    expect(named.container.querySelector('img')?.getAttribute('alt')).toBe('AD');
    expect(root(named.container).hasAttribute('data-initials')).toBe(false);

    const bare = render(Avatar, { src: 'https://x.test/b.png' });
    expect(bare.container.querySelector('img')?.getAttribute('alt')).toBe('Avatar');
  });

  it('falls back to initials when the photo fails to load', async () => {
    const { container } = render(Avatar, {
      src: 'https://x.test/broken.png',
      initials: 'AD',
      showSilhouette: false
    });
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    await fireEvent.error(img as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    expect(root(container).dataset.initials).toBe('AD');
  });

  /** MICA-417: a name in, `initialsOf` letters out, and `initials` still wins when both arrive. */
  describe('name', () => {
    it('derives initials from a name or a handle', () => {
      const named = render(Avatar, { name: 'Ada Lovelace', showSilhouette: false });
      expect(root(named.container).dataset.initials).toBe('AL');

      const handle = render(Avatar, { name: '@grace', showSilhouette: false });
      expect(root(handle.container).dataset.initials).toBe('G');
    });

    it('keeps explicit initials over a name', () => {
      const { container } = render(Avatar, {
        name: 'Ada Lovelace',
        initials: 'XY',
        showSilhouette: false
      });
      expect(root(container).dataset.initials).toBe('XY');
    });

    it('draws the silhouette, not a "?", when the name holds nothing to draw', () => {
      const { container } = render(Avatar, { name: '  @ ', showSilhouette: false });
      expect(container.querySelector('svg')).not.toBeNull();
      expect(root(container).hasAttribute('data-initials')).toBe(false);
    });

    it('names a photo by the name it was given', () => {
      const { container } = render(Avatar, { src: 'https://x.test/a.png', name: 'Ada Lovelace' });
      expect(container.querySelector('img')?.getAttribute('alt')).toBe('Ada Lovelace');
    });
  });
});
