/**
 * How many CSS pixels of content one pixel of cursor travel is worth.
 *
 * The phone is drawn through a `transform: scale()` (see `shell/state/display.ts`), and
 * the two sides of this calculation live on opposite sides of it: `clientX`/`clientY` are
 * in on-screen pixels, while `scrollTop` or a dragged element's own CSS transform are in
 * the element's own unscaled ones. Applied 1:1, a phone drawn at 75% scrolled — or
 * dragged — three quarters as far as the cursor moved, so content visibly lagged behind
 * the grab.
 *
 * Measured off the element rather than read from the `phoneScale` store so this stays a
 * DOM helper with no gPhone state (AGENTS.md §8), and so it is right for any transform in
 * the ancestry rather than only the one we know about. Zero on either side means nothing
 * has been laid out — jsdom — so there is no ratio to apply.
 */
export function measureDragRatio(element: HTMLElement): number {
  const rendered = element.getBoundingClientRect().width;
  const layout = element.offsetWidth;
  return rendered > 0 && layout > 0 ? rendered / layout : 1;
}
