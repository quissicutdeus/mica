// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { conversationsStore } from './conversations';

/**
 * The inbox the mock server holds, and the requests it was asked for.
 *
 * Hoisted because `vi.mock`'s factory is lifted above the imports; the mock body reads it
 * lazily, so a test can reshape the server's data between cases.
 */
const server = vi.hoisted(() => ({
  conversations: [] as any[],
  /** Every `getConversations` payload the store sent, in order. */
  pageRequests: [] as any[]
}));

const DEFAULT_CONVERSATIONS = [
  {
    id: 1,
    citizenid: 'my-id',
    is_group: false,
    name: 'Ursula (Crazy Ex)',
    status: 'active',
    unread_count: 25,
    last_message: {
      id: 101,
      conversation_id: 1,
      citizenid: 'gta-ursula',
      message: 'ANSWER ME NOW!',
      created_at: '2026-07-24T20:00:00Z'
    },
    participants: [
      {
        id: 10,
        conversation_id: 1,
        citizenid: 'gta-ursula',
        role: 'member',
        status: 'active',
        last_read: '2026-07-24T19:00:00Z',
        contact: { firstname: 'Ursula', lastname: '', phone: '555-0199' }
      }
    ]
  },
  {
    id: 2,
    citizenid: 'my-id',
    is_group: false,
    name: 'Trevor Philips',
    status: 'active',
    unread_count: 0,
    last_message: {
      id: 201,
      conversation_id: 2,
      citizenid: 'my-id',
      message: 'Stash is secure.',
      created_at: '2026-07-24T21:00:00Z'
    },
    participants: [
      {
        id: 20,
        conversation_id: 2,
        citizenid: 'gta-trevor',
        role: 'member',
        status: 'active',
        last_read: '2026-07-24T21:00:00Z',
        contact: { firstname: 'Trevor', lastname: 'Philips', phone: '555-0123' }
      }
    ]
  }
];

vi.mock('../nui/fetchNui', () => ({
  fetchNui: vi.fn((method: string, data?: any) => {
    if (method === 'getCitizenId') return Promise.resolve('my-id');
    if (method === 'getConversations') {
      server.pageRequests.push(data);
      /**
       * `conversations:get` as MICA-197 left it: keyset on `id DESC`, `cursor` a bare row
       * id and exclusive, `limit` clamped at the declared page size — and a **bare array**
       * back, with no `nextCursor`. That last part is the whole reason the store has to
       * infer the cursor, so the mock must keep answering that shape rather than the
       * `{ rows, nextCursor }` a paged service would.
       */
      const limit = Math.min(typeof data?.limit === 'number' ? data.limit : 200, 200);
      const ordered = [...server.conversations].sort((a, b) => b.id - a.id);
      const after = data?.cursor == null ? ordered : ordered.filter((c) => c.id < data.cursor);
      return Promise.resolve(after.slice(0, limit));
    }
    if (method === 'getMessages') {
      return Promise.resolve([
        {
          id: 201,
          conversation_id: data.conversation_id,
          citizenid: 'my-id',
          message: 'Stash is secure.',
          created_at: '2026-07-24T21:00:00Z'
        }
      ]);
    }
    if (method === 'sendMessage') {
      return Promise.resolve({
        id: 999,
        conversation_id: data.conversation_id,
        citizenid: 'my-id',
        message: data.message,
        created_at: new Date().toISOString()
      });
    }
    if (method === 'readConversation' || method === 'archiveConversation') {
      return Promise.resolve(true);
    }
    // Shaped like the real `edit` action: it echoes the saved body, and only claims
    // `edited` when the text actually changed.
    if (method === 'editMessage') {
      return Promise.resolve({ id: data.id, message: data.message, edited: true });
    }
    if (method === 'deleteMessage') {
      return Promise.resolve(true);
    }
    return Promise.resolve(null);
  })
}));

beforeEach(async () => {
  server.conversations = DEFAULT_CONVERSATIONS.map((c) => ({ ...c }));
  conversationsStore.setActiveConversationId(null);
  // The store is a module singleton, so its window, cursor and thread cache outlive a case.
  // One refetch with no active thread resets all three — which is itself the eviction rule
  // under test further down.
  await conversationsStore.loadConversations();
  server.pageRequests = [];
});

describe('messages store', () => {
  it('loads conversations sorted descending by lastMessageAt', async () => {
    await conversationsStore.loadConversations();
    const convs = get(conversationsStore);

    expect(convs).toHaveLength(2);
    // Trevor (21:00) should be first, Ursula (20:00) second
    expect(convs[0].name).toBe('Trevor Philips');
    expect(convs[1].name).toBe('Ursula (Crazy Ex)');
    expect(convs[1].unreadCount).toBe(25);
  });

  it('loads messages for a conversation and assigns sender tags', async () => {
    await conversationsStore.loadMessages(2);
    const msgs = get(conversationsStore.messages)[2];

    expect(msgs).toHaveLength(1);
    expect(msgs[0].sender).toBe('me');
    expect(msgs[0].message).toBe('Stash is secure.');
  });

  it('sends message, updates conversation snippet, and sorts conversation to top', async () => {
    await conversationsStore.loadConversations();
    await conversationsStore.loadMessages(1);

    // Initially Trevor is #1, Ursula is #2
    expect(get(conversationsStore)[0].id).toBe(2);

    // Reply to Ursula (id 1)
    await conversationsStore.sendMessage(1, 'Fine I am calling now');

    const updatedConvs = get(conversationsStore);
    // Ursula (id 1) should now be #1 because of newest message
    expect(updatedConvs[0].id).toBe(1);
    expect(updatedConvs[0].lastMessage).toBe('Fine I am calling now');
  });

  /**
   * Editing and unsending (MICA-68).
   *
   * Both change the thread *and* the inbox row's preview, because the conversation keeps a
   * denormalised copy of its last message so the list can render without loading every
   * thread. Unsending your newest text and leaving the list quoting it was the failure
   * these two assertions exist for.
   */
  it('applies an edit to the thread and raises the edited marker', async () => {
    await conversationsStore.loadConversations();
    await conversationsStore.loadMessages(2);

    await conversationsStore.editMessage(2, 201, 'Stash is very secure.');

    const msgs = get(conversationsStore.messages)[2];
    expect(msgs[0].message).toBe('Stash is very secure.');
    expect(msgs[0].edited).toBe(true);

    const conv = get(conversationsStore).find((c) => c.id === 2);
    expect(conv?.lastMessage).toBe('Stash is very secure.');
  });

  it('unsends a message and drops it out of the conversation preview', async () => {
    await conversationsStore.loadConversations();
    await conversationsStore.loadMessages(2);

    await conversationsStore.deleteMessage(2, 201);

    expect(get(conversationsStore.messages)[2]).toEqual([]);
    // The thread is empty, so the inbox row must stop quoting the message that is gone.
    expect(get(conversationsStore).find((c) => c.id === 2)?.lastMessage).toBe('');
  });

  it('marks conversation as read', async () => {
    await conversationsStore.loadConversations();
    expect(get(conversationsStore)[1].unreadCount).toBe(25);

    await conversationsStore.markAsRead(1);
    expect(get(conversationsStore)[1].unreadCount).toBe(0);
  });

  /**
   * Both directions, and the payload names the direction as `status` (MICA-208): the
   * server's contract requires that field, so a store sending anything else is refused.
   */
  it('archives a conversation and brings it back, naming the status each time', async () => {
    const { fetchNui } = await import('../nui/fetchNui');
    const lastSent = () => {
      const calls = vi
        .mocked(fetchNui)
        .mock.calls.filter(([method]) => method === 'archiveConversation');
      return calls[calls.length - 1]?.[1];
    };

    await conversationsStore.archiveConversation(1, true);
    expect(get(conversationsStore).find((c) => c.id === 1)?.status).toBe('archived');
    expect(lastSent()).toEqual({ conversation_id: 1, status: 'archived' });

    await conversationsStore.archiveConversation(1, false);
    expect(get(conversationsStore).find((c) => c.id === 1)?.status).toBe('active');
    expect(lastSent()).toEqual({ conversation_id: 1, status: 'active' });
  });
});

/**
 * The inbox as a server-paged window (MICA-204).
 *
 * The list was a hand-written `fetchNui` that asked for everything and held it. MICA-197
 * gave `conversations:get` a `limit` and a `cursor` and nothing on this side sent either,
 * so a player past the server's page size simply could not see the rest of their inbox —
 * the reply was silently truncated and nothing said so.
 */
describe('conversation paging', () => {
  /** More threads than one server page, so the second page is real rather than simulated. */
  const overOnePage = (count: number) =>
    Array.from({ length: count }, (_, i) => {
      const id = i + 1;
      return {
        id,
        citizenid: 'my-id',
        is_group: false,
        name: `Thread ${id}`,
        status: 'active',
        unread_count: 0,
        // Recency ascends with the id, so the display order and the keyset order agree and
        // an assertion about one is an assertion about the other.
        updated_at: new Date(Date.UTC(2026, 0, 1) + id * 60_000).toISOString(),
        participants: []
      };
    });

  it('asks for one page, then walks the cursor for the next', async () => {
    server.conversations = overOnePage(201);

    await conversationsStore.loadConversations();

    expect(get(conversationsStore)).toHaveLength(200);
    expect(get(conversationsStore.hasMore)).toBe(true);
    expect(server.pageRequests[0].limit).toBe(200);
    expect(server.pageRequests[0].cursor).toBeUndefined();

    const arrived = await conversationsStore.loadMoreConversations();

    expect(arrived).toBe(true);
    // The cursor is the lowest id of the page already held — row 200 in `id DESC`, which is
    // thread 2 — and it is exclusive, so thread 1 is what comes back.
    expect(server.pageRequests[1].cursor).toBe(2);
    const rows = get(conversationsStore);
    expect(rows).toHaveLength(201);
    expect(rows[rows.length - 1].id).toBe(1);
    expect(get(conversationsStore.hasMore)).toBe(false);
  });

  it('reports no more pages when the first one comes back short', async () => {
    await conversationsStore.loadConversations();

    expect(get(conversationsStore.hasMore)).toBe(false);
    expect(await conversationsStore.loadMoreConversations()).toBe(false);
    // Nothing was asked for beyond the first page.
    expect(server.pageRequests).toHaveLength(1);
  });

  /**
   * The cost of inferring the cursor from a bare array rather than being handed one: a list
   * that divides exactly by the page size looks like it has another page, and only the empty
   * reply settles it. It must settle it, rather than offering the button forever.
   */
  it('self-corrects when the list divides exactly by the page size', async () => {
    server.conversations = overOnePage(200);

    await conversationsStore.loadConversations();
    expect(get(conversationsStore.hasMore)).toBe(true);

    expect(await conversationsStore.loadMoreConversations()).toBe(false);
    expect(get(conversationsStore.hasMore)).toBe(false);
    expect(get(conversationsStore)).toHaveLength(200);
  });
});

/**
 * The thread cache, bounded (MICA-204).
 *
 * `messagesByConversation` was written at six sites and evicted at none, so a session held
 * every thread it had ever opened, in full, until the phone closed.
 */
describe('resident threads', () => {
  const openThreads = async (ids: number[]) => {
    for (const id of ids) await conversationsStore.loadMessages(id);
  };

  const heldThreadIds = () =>
    Object.keys(get(conversationsStore.messages))
      .map(Number)
      .sort((a, b) => a - b);

  it('holds at most five threads, dropping the least recently opened', async () => {
    await openThreads([1, 2, 3, 4, 5]);
    expect(heldThreadIds()).toEqual([1, 2, 3, 4, 5]);

    await openThreads([6]);

    // Thread 1 was opened longest ago, so it is what the sixth open costs.
    expect(heldThreadIds()).toEqual([2, 3, 4, 5, 6]);
  });

  it('counts recency by last open, not by first', async () => {
    await openThreads([1, 2, 3, 4, 5]);
    // Re-opening 1 makes 2 the stale end instead.
    await openThreads([1, 6]);

    expect(heldThreadIds()).toEqual([1, 3, 4, 5, 6]);
  });

  it('gives back every thread but the one on screen when the inbox is refetched', async () => {
    await openThreads([1, 2, 3]);
    expect(heldThreadIds()).toEqual([1, 2, 3]);

    // `loadMessages` leaves the last thread opened as the active one, and it is what is
    // rendered — dropping it would blank the conversation until the refetch landed.
    await conversationsStore.loadConversations();

    expect(heldThreadIds()).toEqual([3]);
  });

  it('releases everything when no thread is on screen', async () => {
    await openThreads([1, 2, 3]);
    conversationsStore.setActiveConversationId(null);

    await conversationsStore.loadConversations();

    expect(heldThreadIds()).toEqual([]);
  });

  it('forgets the messages of a deleted conversation', async () => {
    await conversationsStore.loadConversations();
    await openThreads([1, 2]);

    await conversationsStore.deleteConversation(1);

    expect(heldThreadIds()).toEqual([2]);
    expect(get(conversationsStore).some((c) => c.id === 1)).toBe(false);
  });
});

/**
 * `addReceivedMessage` is what the server push lands on, and its semantics are load-bearing
 * rather than incidental — the row id it forwards (c46d2a6) is what a later reaction or
 * unsend is keyed on, and the placeholder is what keeps a caller with no row from crashing
 * the thread.
 */
describe('a message arriving live', () => {
  it('keeps the pushed row id', async () => {
    await conversationsStore.loadConversations();
    await conversationsStore.loadMessages(2);

    conversationsStore.addReceivedMessage({
      id: 4242,
      conversation_id: 2,
      message: 'On my way'
    });

    const msgs = get(conversationsStore.messages)[2];
    expect(msgs[msgs.length - 1].id).toBe(4242);
    expect(msgs[msgs.length - 1].sender).toBe('other');
  });

  it('invents an id only for a caller that has no row', async () => {
    await conversationsStore.loadConversations();
    await conversationsStore.loadMessages(2);

    conversationsStore.addReceivedMessage({ conversation_id: 2, message: 'No row here' });

    const msgs = get(conversationsStore.messages)[2];
    expect(typeof msgs[msgs.length - 1].id).toBe('number');
    expect(msgs[msgs.length - 1].message).toBe('No row here');
  });

  it('bumps the thread to the top of the inbox and counts it unread', async () => {
    await conversationsStore.loadConversations();
    // Ursula (id 1) is second on load; a message from her puts her first.
    expect(get(conversationsStore)[0].id).toBe(2);

    conversationsStore.addReceivedMessage({
      id: 4243,
      conversation_id: 1,
      message: 'STILL WAITING',
      created_at: new Date().toISOString()
    });

    const rows = get(conversationsStore);
    expect(rows[0].id).toBe(1);
    expect(rows[0].lastMessage).toBe('STILL WAITING');
    expect(rows[0].unreadCount).toBe(26);
  });

  it('opens a row for a conversation the inbox has never seen', async () => {
    await conversationsStore.loadConversations();

    conversationsStore.addReceivedMessage({
      id: 4244,
      conversation_id: 77,
      message: 'Wrong number?',
      phone: '555-0000',
      senderName: 'Unknown Caller',
      created_at: new Date().toISOString()
    });

    const placeholder = get(conversationsStore).find((c) => c.id === 77);
    expect(placeholder?.targetName).toBe('Unknown Caller');
    expect(placeholder?.unreadCount).toBe(1);
    // No thread was open for it, so nothing is cached for it either — the messages arrive
    // on the next open.
    expect(get(conversationsStore.messages)[77]).toBeUndefined();
  });
});
