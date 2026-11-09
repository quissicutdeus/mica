// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import ReactionBar from './ReactionBar.svelte';
import { EMOJI_PALETTE } from './emojiData';

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

  it('reports a pick from the palette through the same verb', async () => {
    const ontoggle = vi.fn();
    const { getByLabelText, getAllByLabelText } = render(ReactionBar, { ontoggle });

    getByLabelText('Add reaction').click();
    await tick();
    getAllByLabelText(/^React with /)[0].click();

    expect(ontoggle).toHaveBeenCalledTimes(1);
  });

  describe('the picker mounts only when asked for (MICA-448)', () => {
    it('draws one trigger and no palette until it is pressed', () => {
      const { container, queryAllByLabelText, getAllByLabelText } = render(ReactionBar, {
        summary: { counts: { '👍': 2 }, mine: [] },
        ontoggle: () => {}
      });

      expect(queryAllByLabelText(/^React with /)).toHaveLength(0);
      const [trigger] = getAllByLabelText('Add reaction');
      expect(queryAllByLabelText('More emoji')).toHaveLength(0);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      // The chip and the trigger, nothing else.
      expect(container.querySelectorAll('button')).toHaveLength(2);
    });

    it('opens to the same picker it always drew, with focus on its first button', async () => {
      const ontoggle = vi.fn();
      const { container, getByLabelText, getAllByLabelText, queryAllByLabelText } = render(
        ReactionBar,
        {
          summary: { counts: { '👍': 2 }, mine: ['👍'] },
          ontoggle
        }
      );

      getByLabelText('Add reaction').click();
      await tick();

      const palette = getAllByLabelText(/^React with /);
      expect(palette).toHaveLength(EMOJI_PALETTE.length);
      // `openPicker` focuses after its own `tick()`, which can land after this test's.
      await vi.waitFor(() => expect(document.activeElement).toBe(palette[0]));
      // Its own "+" for the full catalog is back, collapsed, and the trigger is gone.
      expect(queryAllByLabelText('Add reaction')).toHaveLength(0);
      const more = getAllByLabelText('More emoji');
      expect(more).toHaveLength(1);
      expect(more[0].getAttribute('aria-expanded')).toBe('false');
      // The chips are untouched by the open.
      expect(chips(container)).toHaveLength(1);

      palette[1].click();
      await tick();
      expect(ontoggle).toHaveBeenCalledWith(EMOJI_PALETTE[1]);
      // It stays open after a pick, as the always-mounted picker did.
      expect(getAllByLabelText(/^React with /)).toHaveLength(EMOJI_PALETTE.length);
    });
  });
});
