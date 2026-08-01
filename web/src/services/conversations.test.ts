import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { conversationsStore } from './conversations';

vi.mock('../nui/fetchNui', () => ({
  fetchNui: vi.fn((method: string, data?: any) => {
    if (method === 'getCitizenId') return Promise.resolve('my-id');
    if (method === 'getConversations') {
      return Promise.resolve([
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
      ]);
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
    if (method === 'readConversation') {
      return Promise.resolve(true);
    }
    return Promise.resolve(null);
  })
}));

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

  it('marks conversation as read', async () => {
    await conversationsStore.loadConversations();
    expect(get(conversationsStore)[1].unreadCount).toBe(25);

    await conversationsStore.markAsRead(1);
    expect(get(conversationsStore)[1].unreadCount).toBe(0);
  });
});
