// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import ReactionBar from './ReactionBar.svelte';

/** Only the chips — the picker's buttons are `EmojiPicker`'s and are labelled "React with …". */
const chips = (container: HTMLElement) =>
  [...container.querySelectorAll('button[aria-pressed]')] as HTMLButtonElement[];

/**
 * The render half of the reactions primitive (MICA-98).
 *
 * It holds no state, so what is worth pinning is the small set of decisions it does make:
 * the order chips appear in, which ones it draws at all, whether it says a chip is yours,
 * and that every path out of it is the same single verb.
 */
describe('ReactionBar', () => {
  it('draws a chip per emoji, busiest first', () => {
    const { container } = render(ReactionBar, {
      summary: { counts: { '👍': 1, '🔥': 4, '😂': 2 }, mine: [] },
      ontoggle: () => {}
    });

    expect(chips(container).map((b) => b.textContent?.replace(/\s+/g, ''))).toEqual([
      '🔥4',
      '😂2',
      '👍1'
    ]);
  });

  it('breaks a tie on the emoji, so a refetch cannot reorder chips under a thumb', () => {
    const { container } = render(ReactionBar, {
      summary: { counts: { '🔥': 1, '👍': 1 }, mine: [] },
      ontoggle: () => {}
    });

    const first = chips(container).map((b) => b.textContent?.replace(/\s+/g, ''));

    const second = render(ReactionBar, {
      // The same two counts, enumerated the other way round.
      summary: { counts: { '👍': 1, '🔥': 1 }, mine: [] },
      ontoggle: () => {}
    });

    expect(chips(second.container).map((b) => b.textContent?.replace(/\s+/g, ''))).toEqual(first);
  });

  it('draws nothing for a target nobody has reacted to', () => {
    const { container } = render(ReactionBar, { ontoggle: () => {} });
    expect(chips(container)).toHaveLength(0);
  });

  it('drops a count the server sent as zero rather than drawing an empty chip', () => {
    const { container } = render(ReactionBar, {
      summary: { counts: { '👍': 0, '🔥': 1 }, mine: [] },
      ontoggle: () => {}
    });
    expect(chips(container)).toHaveLength(1);
  });

  it('marks the ones that are yours, for a screen reader as well as by colour', () => {
    const { container } = render(ReactionBar, {
      summary: { counts: { '👍': 2, '🔥': 1 }, mine: ['👍'] },
      ontoggle: () => {}
    });

    const [mine, theirs] = chips(container);
    expect(mine.getAttribute('aria-pressed')).toBe('true');
    expect(mine.getAttribute('aria-label')).toContain('tap to remove yours');
    expect(theirs.getAttribute('aria-pressed')).toBe('false');
    expect(theirs.getAttribute('aria-label')).toContain('tap to add yours');
  });

  it('reports a tap as one verb, whether the chip is yours or not', async () => {
    const ontoggle = vi.fn();
    const { container } = render(ReactionBar, {
      summary: { counts: { '👍': 2, '🔥': 1 }, mine: ['👍'] },
      ontoggle
    });

    const [mine, theirs] = chips(container);
    mine.click();
    theirs.click();

    // One callback, not an `onreact`/`onunreact` pair whose consumer has to re-derive from
    // `mine` a decision this component already made.
    expect(ontoggle.mock.calls).toEqual([['👍'], ['🔥']]);
  });

  it('reports a pick from the palette through the same verb', () => {
    const ontoggle = vi.fn();
    const { getAllByLabelText } = render(ReactionBar, { ontoggle });

    getAllByLabelText(/^React with /)[0].click();

    expect(ontoggle).toHaveBeenCalledTimes(1);
  });
});
