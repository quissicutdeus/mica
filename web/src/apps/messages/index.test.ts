// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * Opening a thread, end to end inside the app (MICA-448): the first page the open shows, how
 * it grows into the page `usePagedList` pages by, the unread divider that has to be inside it,
 * and the inbox that stays mounted underneath.
 *
 * The transport is stubbed at `fetchNui`, the one layer every typed `call()` goes through, and
 * answers the four actions an open touches. Anything else answers its default, as the real
 * layer does when the caller gave one, and `null` when it did not.
 */
import '../../host/registerFacets';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import { render, fireEvent, waitFor } from '@testing-library/svelte';

/** Each thread's other side, which is also how the inbox names it: nobody is in the contacts. */
const phoneOf = vi.hoisted(() => (id: number) => `555-${String(id).padStart(4, '0')}`);

interface MockServer {
  /** Each thread's rows in reading order, keyed by conversation id. */
  threads: Record<number, { id: number; message: string; created_at: string }[]>;
  /** Each thread's unread count, as the inbox answers it. */
  unread: Record<number, number>;
}

const server = vi.hoisted((): MockServer => ({ threads: {}, unread: {} }));

vi.mock('../../nui/fetchNui', () => ({
  fetchNui: vi.fn(
    (method: string, payload?: any, options?: { defaultValue?: unknown }): Promise<unknown> => {
      const fallback = () => Promise.resolve(options?.defaultValue ?? null);
      if (method !== 'svc') return fallback();
      const { service, action, data } = payload ?? {};
      const key = `${service}:${action}`;
      if (key === 'conversations:get') {
        const rows = Object.keys(server.threads).map((raw) => {
          const id = Number(raw);
          const thread = server.threads[id];
          const last = thread[thread.length - 1];
          return {
            id,
            is_group: false,
            status: 'active',
            unread_count: server.unread[id] ?? 0,
            created_at: '2026-11-01T00:00:00Z',
            updated_at: last.created_at,
            last_message: { message: last.message, created_at: last.created_at, mine: false },
            participants: [
              { id: id * 10, conversation_id: id, role: 'admin', status: 'active', self: true },
              {
                id: id * 10 + 1,
                conversation_id: id,
                role: 'member',
                status: 'active',
                self: false,
                phone: phoneOf(id)
              }
            ]
          };
        });
        return Promise.resolve({ rows, nextCursor: null });
      }
      if (key === 'messages:send') {
        // The row as the server answers a send: the reader's own, newest in the thread.
        return Promise.resolve({
          id: data.conversation_id * 1000 + 999,
          conversation_id: data.conversation_id,
          mine: true,
          sender_id: data.conversation_id * 10,
          status: 'active',
          message: data.message,
          attachments: [],
          created_at: '2026-11-02T00:00:00Z',
          updated_at: '2026-11-02T00:00:00Z'
        });
      }
      if (key === 'messages:get') {
        // One page of fifty, newest last, and no older page behind it.
        const thread = server.threads[data.conversation_id] ?? [];
        const rows = thread.slice(-50).map((m) => ({
          ...m,
          conversation_id: data.conversation_id,
          mine: false,
          sender_id: data.conversation_id * 10 + 1,
          status: 'active',
          attachments: [],
          updated_at: m.created_at
        }));
        return Promise.resolve({ rows, nextCursor: null });
      }
      return fallback();
    }
  )
}));

import Messages from './index.svelte';
import { conversationsStore } from '../../services/conversations';
import { FIRST_PAGE_ROWS } from './firstPage';

// jsdom has no Web Animations API and some SDK transitions call it on mount.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    startTime: 0,
    currentTime: 0,
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

/** `count` messages for thread `id`, ids `id * 1000 + 1` upward, a minute apart. */
const seed = (id: number, count: number, unread = 0) => {
  server.threads[id] = Array.from({ length: count }, (_, i) => ({
    id: id * 1000 + i + 1,
    message: `Line ${i + 1} of thread ${id}`,
    created_at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString()
  }));
  server.unread[id] = unread;
};

const bubbles = (container: HTMLElement) =>
  container.querySelectorAll('#messages-container [id^="msg-"]');

/** Render the app with the inbox loaded, and open thread `id` from it. */
const openThread = async (id: number) => {
  await conversationsStore.loadConversations();
  const view = render(Messages, { props: { onback: () => {} } });
  await tick();
  const row = await waitFor(() => {
    const found = view.getAllByRole('button').find((el) => el.textContent?.includes(phoneOf(id)));
    if (!found) throw new Error(`no inbox row for thread ${id}`);
    return found;
  });
  await fireEvent.click(row);
  await waitFor(() => expect(bubbles(view.container).length).toBeGreaterThan(0));
  return view;
};

describe('opening a thread (MICA-448)', () => {
  beforeEach(() => {
    server.threads = {};
    server.unread = {};
  });

  it('shows the newest rows of the page first, and the whole page on "Load older"', async () => {
    seed(7, 50);
    const view = await openThread(7);

    expect(bubbles(view.container)).toHaveLength(FIRST_PAGE_ROWS);
    expect(view.container.querySelector('#msg-7050')).not.toBeNull();
    expect(view.container.querySelector('#msg-7001')).toBeNull();

    // Nothing is held back locally by the hook, so the control carries no count: the same
    // label a server page behind the thread would have.
    const control = view.getByRole('button', { name: 'Load older messages' });
    await fireEvent.click(control);
    await waitFor(() => expect(bubbles(view.container)).toHaveLength(50));
    expect(view.container.querySelector('#msg-7001')).not.toBeNull();
    expect(view.queryByRole('button', { name: /Load older messages/ })).toBeNull();
  });

  it('reveals the rest of the page when the reader scrolls to the top', async () => {
    seed(7, 50);
    const view = await openThread(7);
    const scroller = view.container.querySelector('#messages-container') as HTMLElement;
    expect(bubbles(view.container)).toHaveLength(FIRST_PAGE_ROWS);

    scroller.scrollTop = 0;
    await fireEvent.scroll(scroller);
    await waitFor(() => expect(bubbles(view.container)).toHaveLength(50));
  });

  it('opens a short thread whole, with no control', async () => {
    seed(7, 6);
    const view = await openThread(7);
    expect(bubbles(view.container)).toHaveLength(6);
    expect(view.queryByRole('button', { name: /Load older messages/ })).toBeNull();
  });

  it('grows the first page to take in an unread run longer than it', async () => {
    seed(3, 50, 25);
    const view = await openThread(3);

    const divider = view.container.querySelector('#unread-divider');
    expect(divider, 'the divider is rendered').not.toBeNull();
    // Twenty-five unread and the one before them, so the reader sees where the run starts.
    expect(bubbles(view.container)).toHaveLength(26);
    expect(divider?.nextElementSibling?.id).toBe('msg-3026');
  });

  it('keeps a new message below the first page rather than pushing its top row out', async () => {
    seed(7, 50);
    const view = await openThread(7);
    const first = bubbles(view.container)[0].id;

    const boxes = view.getAllByRole('textbox');
    await fireEvent.input(boxes[boxes.length - 1], { target: { value: 'One more' } });
    await fireEvent.click(view.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(bubbles(view.container)).toHaveLength(FIRST_PAGE_ROWS + 1));
    expect(bubbles(view.container)[0].id).toBe(first);
  });

  it('keeps the inbox mounted under the thread, hidden, and shows it again on Back', async () => {
    seed(7, 50);
    seed(8, 3);
    const view = await openThread(7);

    const host = view.getByTestId('conversation-list-host');
    expect(host.classList.contains('hidden')).toBe(true);
    expect(host.textContent).toContain(phoneOf(8));

    await fireEvent.click(view.getByRole('button', { name: 'Go back' }));
    await waitFor(() => expect(view.container.querySelector('#messages-container')).toBeNull());
    expect(view.getByTestId('conversation-list-host')).toBe(host);
    expect(host.classList.contains('hidden')).toBe(false);
  });
});
