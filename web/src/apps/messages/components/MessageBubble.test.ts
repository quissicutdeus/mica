// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-407: no control in a message bubble sits inside another.
 *
 * The bubble toggles its own actions (reply, edit, unsend) on a tap, and it used to be one
 * `<button>` holding two more controls: a quoted reply that jumps to the original, and a
 * shared location's "Add Waypoint" card, both `role="button"`. Interactive inside
 * interactive is invalid ARIA whatever the tag — two tab stops in one control and a name
 * made of everything in it. These pin the structure and that each action still fires, and
 * fires alone.
 *
 * In-process facets, as `ConversationList.test.ts` sets them up — a unit test stands in for
 * the shell.
 */
import '../../../host/registerFacets';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { registerMessages, type UIConversation, type UIMessage } from '@mica/sdk';
import { media } from '../../../services/media';
import MessageBubble from './MessageBubble.svelte';
import en from '../locales/en.json';
import de from '../locales/de.json';

registerMessages('messages', { en, de });

/** Every element that takes an activation, native or by role. */
const CONTROL =
  'button, a[href], input, select, textarea, summary, [tabindex], [role="button"], ' +
  '[role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], ' +
  '[role="radio"], [role="switch"]';

const conv = { id: 1, is_group: false, participants: [] } as unknown as UIConversation;

const at = '2026-10-21T09:00:00.000Z';
const message = (over: Partial<UIMessage>): UIMessage => ({
  id: 10,
  conversation_id: 1,
  mine: true,
  sender: 'me',
  sender_id: null,
  message: '',
  created_at: at,
  updated_at: at,
  ...over
});

const original = message({ id: 1, mine: false, sender: 'other', message: 'Meet at the pier' });
const quoting = message({ id: 2, message: 'See you there', replyToMsg: original });
const sharedLocation = message({
  id: 3,
  mine: false,
  sender: 'other',
  attachments: [{ id: 9, media: { id: 9, kind: 'location', data: '{"x":1.5,"y":-2,"z":3}' } }]
});

const props = (msg: UIMessage, over: Record<string, unknown> = {}) => ({
  msg,
  currentConv: conv,
  isLastReadMyMessage: false,
  isReadByOther: false,
  onreply: vi.fn(),
  onscrollto: vi.fn(),
  onedit: vi.fn(),
  ondelete: vi.fn(),
  ...over
});

afterEach(() => vi.restoreAllMocks());

describe('MessageBubble controls (MICA-407)', () => {
  it.each([
    ['a quoted reply', quoting],
    ['a shared location', sharedLocation]
  ])('nests no control inside another, for %s', (_label, msg) => {
    const { container } = render(MessageBubble, props(msg));
    const controls = [...container.querySelectorAll(CONTROL)];
    expect(controls.length).toBeGreaterThan(0);
    const nested = controls.filter((el) => el.parentElement?.closest(CONTROL));
    expect(nested.map((el) => el.outerHTML)).toEqual([]);
  });

  it('toggles the actions from the bubble, and says whether they are open', async () => {
    const { getByRole, queryByRole } = render(MessageBubble, props(quoting));
    const bubble = getByRole('button', { name: 'See you there' });
    expect(bubble.getAttribute('aria-expanded')).toBe('false');
    expect(queryByRole('button', { name: en.replyToMessage })).toBeNull();

    await fireEvent.click(bubble);
    expect(bubble.getAttribute('aria-expanded')).toBe('true');
    expect(queryByRole('button', { name: en.replyToMessage })).not.toBeNull();
    expect(queryByRole('button', { name: en.editMessage })).not.toBeNull();

    await fireEvent.click(bubble);
    expect(queryByRole('button', { name: en.replyToMessage })).toBeNull();
  });

  it('jumps to the original from the quote, and only that', async () => {
    const onscrollto = vi.fn();
    const { getByRole, queryByRole } = render(MessageBubble, props(quoting, { onscrollto }));
    const quote = getByRole('button', { name: /Meet at the pier/ });
    // A native button, so Enter and Space are the browser's, not a keydown of ours.
    expect(quote.tagName).toBe('BUTTON');
    expect(quote.getAttribute('title')).toBe(en.jumpToOriginal);

    await fireEvent.click(quote);
    expect(onscrollto).toHaveBeenCalledExactlyOnceWith(1);
    expect(queryByRole('button', { name: en.replyToMessage })).toBeNull();
  });

  it('sets a waypoint from a shared location, and only that', async () => {
    const setWaypoint = vi.spyOn(media, 'setWaypoint').mockResolvedValue(undefined);
    const { getByRole, queryByRole } = render(MessageBubble, props(sharedLocation));
    const card = getByRole('button', { name: new RegExp(en.addWaypoint) });
    expect(card.tagName).toBe('BUTTON');

    await fireEvent.click(card);
    await vi.waitFor(() => expect(setWaypoint).toHaveBeenCalledExactlyOnceWith(1.5, -2));
    expect(queryByRole('button', { name: en.replyToMessage })).toBeNull();
  });

  it('names a bubble that holds only a location, so its actions stay reachable', async () => {
    const { getByRole, queryByRole } = render(MessageBubble, props(sharedLocation));
    const bubble = getByRole('button', { name: en.location });
    await fireEvent.click(bubble);
    expect(queryByRole('button', { name: en.replyToMessage })).not.toBeNull();
  });
});
