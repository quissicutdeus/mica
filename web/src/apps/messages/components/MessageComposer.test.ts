// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: in-process facets, as `ConversationList.test.ts` sets them up — a unit test
 * stands in for the shell.
 */
import '../../../host/registerFacets';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { registerMessages } from '@mica/sdk';
import MessageComposer from './MessageComposer.svelte';
import en from '../locales/en.json';
import de from '../locales/de.json';

// jsdom has no `Element.animate`, and the attach menu flies in. The stub is
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

registerMessages('messages', { en, de });

/**
 * MICA-408: the attach menu and the photo picker are opened by the app, not by this row.
 *
 * Back closes them one at a time, and the `levels` stack that decides what Back closes lives
 * in `index.svelte`, so the flags have to be the app's. When the composer kept copies of its
 * own, the app opened a picker nothing rendered and Back closed it, while the menu the player
 * could see stayed open. These pin that the composer draws exactly what it is handed.
 */
const props = (over: Record<string, unknown> = {}) => ({
  text: '',
  attachments: [],
  busy: false,
  onsend: vi.fn(),
  onopenphotos: vi.fn(),
  ...over
});

describe('MessageComposer attach menu and picker', () => {
  it('draws the picker when the app opens it, and not before', async () => {
    const { queryByRole, rerender } = render(MessageComposer, props());
    expect(queryByRole('dialog')).toBeNull();
    await rerender(props({ pickerOpen: true }));
    expect(queryByRole('dialog', { name: en.selectPhotos })).not.toBeNull();
  });

  it('asks the app to open the picker from the attach menu', async () => {
    const onopenphotos = vi.fn();
    const { getByRole } = render(MessageComposer, props({ onopenphotos }));
    await fireEvent.click(getByRole('button', { name: en.attachments }));
    await fireEvent.click(getByRole('button', { name: en.photo }));
    expect(onopenphotos).toHaveBeenCalledOnce();
  });

  it('draws the attach menu the app says is open', async () => {
    const { queryByRole, rerender } = render(MessageComposer, props());
    expect(queryByRole('button', { name: en.photo })).toBeNull();
    await rerender(props({ attachMenuOpen: true }));
    expect(queryByRole('button', { name: en.photo })).not.toBeNull();
  });
});
