// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import AppIconTile from './AppIconTile.svelte';
import Icon from './icons/AddIcon.svelte';

/**
 * One renderer for six surfaces.
 *
 * These pin what the six hand-written copies disagreed about, not the markup: the corner
 * radius scaling with the tile, the glyph being sized rather than left at its 32px default,
 * a `data:` icon reaching an `<img>` at all, and no filter turning a light glyph dark.
 */
describe('AppIconTile', () => {
  const props = { name: 'Blabber', color: 'bg-sky-500' };

  it('draws a string icon as an image, whatever the URL scheme', () => {
    // The Settings surfaces guarded on `startsWith('http')`, so a catalog icon — which is a
    // `data:` URI — fell through to the monogram, and an installed add-on showed a letter in
    // Settings and its real glyph everywhere else.
    const { container } = render(AppIconTile, {
      ...props,
      icon: 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E'
    });

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toMatch(/^data:image\/svg\+xml,/);
  });

  it('applies no filter to the glyph', () => {
    // `invert filter` predates catalog icons carrying a colour chosen against their own tile.
    // Inverting one now turns the white glyph black on a saturated background.
    const { container } = render(AppIconTile, { ...props, icon: 'data:image/svg+xml,%3Csvg%3E' });

    expect(container.querySelector('img')?.className).not.toMatch(/invert|filter/);
  });

  it('sizes a component icon rather than leaving it at its own default', () => {
    // Every `Icon.svelte` defaults `class` to `h-8 w-8`. Unsized, a 32px glyph landed in a
    // 36px Settings row.
    const { container } = render(AppIconTile, { ...props, icon: Icon, size: 'sm' });

    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('class')).toBe('size-icon-md');
  });

  it('falls back to a monogram when an app has no icon', () => {
    const { container } = render(AppIconTile, { ...props, icon: null });

    expect(container.textContent?.trim()).toBe('B');
  });

  /**
   * The shape, which was the whole complaint: a size-named radius on a differently-sized box
   * clamped a 44px catalog row to a circle while leaving a 56px launcher tile square. Every
   * size takes the same role now, so a tile cannot disagree with the row around it.
   */
  it.each([
    ['sm', 'h-9'],
    ['md', 'h-11'],
    ['lg', 'h-14'],
    ['xl', 'h-20']
  ] as const)('draws %s at %s with the box radius', (size, box) => {
    const { container } = render(AppIconTile, { ...props, icon: null, size });

    const tile = container.firstElementChild;
    expect(tile?.className).toContain(box);
    expect(tile?.className).toContain('rounded-box');
    expect(tile?.className).toContain('bg-sky-500');
  });

  it('keeps the caller class alongside its own', () => {
    const { container } = render(AppIconTile, { ...props, icon: null, class: 'cursor-pointer' });

    expect(container.firstElementChild?.className).toContain('cursor-pointer');
  });
});
