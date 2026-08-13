import { writable, derived, get } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import type { Contact, Conversation, Message } from '@shared/types';

import { citizenid, fetchCitizenId } from './account';
import { contacts } from './contacts';

export interface UIConversation extends Conversation {
  target: string; // The phone number or identifier of the other person
  targetName: string; // Display name
  targetAvatar?: string; // Contact profile image URL
  lastMessage: string; // Content string
  lastMessageAt: string; // ISO date
  unreadCount: number;
}

export interface UIMessage extends Message {
  sender: 'me' | 'other';
  replyToMsg?: UIMessage | null;
}

function createMessagesStore() {
  const { subscribe, set, update } = writable<UIConversation[]>([]);

  // Store messages by conversation ID
  const messagesByConversation = writable<Record<number, UIMessage[]>>({});
  const activeConversationId = writable<number | null>(null);

  /**
   * False until the first conversation fetch has come back.
   *
   * The same signal `createCrudStore` exposes, so every list in the phone can tell
   * "still arriving" from "there is nothing here" the same way.
   */
  const loaded = writable(false);

  // Helper to resolve display info
  const resolveDisplayInfo = (conv: Conversation, myId: string, currentContacts: Contact[]) => {
    let target = '';
    let targetName = conv.name || 'Unknown';
    let targetAvatar: string | undefined = undefined;

    if (conv.is_group) {
      target = 'group';
      targetName = conv.name || 'Group Chat';
    } else {
      // Find other participant
      const other = conv.participants?.find((p) => p.citizenid !== myId);
      if (other) {
        if (other.contact) {
          target = other.contact.phone;
          targetName = `${other.contact.firstname} ${other.contact.lastname || ''}`.trim();
          targetAvatar = other.contact.avatar;
        } else {
          target = other.citizenid;
        }
      }
    }

    // If we have a phone target, try to improve name & avatar from address book
    if (target && target !== 'group') {
      const found = currentContacts.find((c) => c.phone === target);
      if (found) {
        targetName = `${found.firstname} ${found.lastname || ''}`.trim();
        targetAvatar = found.avatar;
      }
    }

    return { target, targetName, targetAvatar };
  };

  return {
    subscribe,
    loaded: { subscribe: loaded.subscribe },
    messages: { subscribe: messagesByConversation.subscribe },
    activeConversationId: { subscribe: activeConversationId.subscribe },

    setActiveConversationId: (id: number | null) => activeConversationId.set(id),

    loadConversations: async () => {
      let myId = get(citizenid);
      if (!myId) {
        myId = await fetchCitizenId();
      }
      const currentContacts = get(contacts);

      try {
        const data = await fetchNui<Conversation[]>('getConversations', {}, { defaultValue: [] });
        const mapped: UIConversation[] = (data || []).map((c) => {
          const { target, targetName, targetAvatar } = resolveDisplayInfo(c, myId, currentContacts);
          return {
            ...c,
            target,
            targetName,
            targetAvatar,
            lastMessage: c.last_message?.message || '',
            lastMessageAt: (c.last_message?.created_at || c.updated_at) as string,
            unreadCount: c.unread_count || 0
          };
        });

        // Sort newest-first initially
        mapped.sort(
          (a, b) =>
            new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime()
        );

        set(mapped);
        loaded.set(true);
      } catch (e) {
        console.error('Failed to load conversations:', e);
        loaded.set(true);
      }
    },

    loadMessages: async (conversationId: number) => {
      activeConversationId.set(conversationId);
      let myId = get(citizenid);
      if (!myId) myId = await fetchCitizenId();

      const data = await fetchNui<Message[]>(
        'getMessages',
        { conversation_id: conversationId },
        { defaultValue: [] }
      );
      const rawList = data || [];
      const mapped: UIMessage[] = rawList.map((m) => {
        const replyToRaw = m.reply_to_id ? rawList.find((r) => r.id === m.reply_to_id) : null;
        return {
          ...m,
          sender: m.citizenid === myId ? 'me' : 'other',
          replyToMsg: replyToRaw
            ? {
                ...replyToRaw,
                sender: replyToRaw.citizenid === myId ? 'me' : 'other'
              }
            : null
        };
      });

      messagesByConversation.update((msgs) => ({
        ...msgs,
        [conversationId]: mapped
      }));
    },

    sendMessage: async (
      conversationId: number,
      message: string,
      attachments: { photo_id: number; attachment?: string }[] = [],
      replyToId?: number | null
    ) => {
      const payload = {
        conversation_id: conversationId,
        message,
        attachments,
        reply_to_id: replyToId
      };

      try {
        const sent = await fetchNui<Message>('sendMessage', payload);
        if (!sent) return null;

        let replyToMsg: UIMessage | null = null;
        if (replyToId) {
          const currentMsgs = get(messagesByConversation)[conversationId] || [];
          replyToMsg = currentMsgs.find((m) => m.id === replyToId) || null;
        }

        const uiSent: UIMessage = { ...sent, sender: 'me', replyToMsg };

        messagesByConversation.update((msgs) => ({
          ...msgs,
          [conversationId]: [...(msgs[conversationId] || []), uiSent]
        }));

        // Update conversation last message snippet (optimistic) and sort to top
        update((convs) => {
          const updated = convs.map((c) => {
            if (c.id === conversationId) {
              return {
                ...c,
                lastMessage: sent.message,
                lastMessageAt: sent.created_at as string,
                last_message: sent
              };
            }
            return c;
          });
          return updated.sort(
            (a, b) =>
              new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime()
          );
        });

        return sent;
      } catch (e) {
        console.error('Failed to send message:', e);
        throw e;
      }
    },

    startConversation: async (phone: string, isGroup: boolean = false) => {
      let myId = get(citizenid);
      const currentContacts = get(contacts);

      try {
        const newConv = await fetchNui<Conversation>('startConversation', {
          is_group: isGroup,
          phone
        });
        if (!newConv) return null;

        // Map it
        const { target, targetName, targetAvatar } = resolveDisplayInfo(
          newConv,
          myId,
          currentContacts
        );
        const mapped: UIConversation = {
          ...newConv,
          target,
          targetName,
          targetAvatar,
          lastMessage: '',
          lastMessageAt: newConv.created_at as string,
          unreadCount: 0
        };

        update((n) => [mapped, ...n]);
        return mapped;
      } catch (e) {
        console.error('Failed to start conversation', e);
        throw e;
      }
    },

    markAsRead: async (conversationId: number) => {
      update((convs) => convs.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)));
      try {
        await fetchNui('readConversation', { conversation_id: conversationId });
      } catch (e) {
        console.error('Failed to mark conversation read', e);
      }
    },

    archiveConversation: async (conversationId: number, archive: boolean = true) => {
      const nextStatus = archive ? 'archived' : 'active';
      update((convs) =>
        convs.map((c) => (c.id === conversationId ? { ...c, status: nextStatus } : c))
      );
      try {
        await fetchNui('archiveConversation', {
          conversation_id: conversationId,
          status: nextStatus
        });
      } catch (e) {
        console.error('Failed to archive conversation', e);
      }
    },

    deleteConversation: async (conversationId: number) => {
      update((convs) => convs.filter((c) => c.id !== conversationId));
      try {
        await fetchNui('deleteConversation', { conversation_id: conversationId });
      } catch (e) {
        console.error('Failed to delete conversation', e);
      }
    },

    renameConversation: async (conversationId: number, name: string) => {
      update((convs) =>
        convs.map((c) => (c.id === conversationId ? { ...c, name, targetName: name } : c))
      );
      try {
        // `id`, not `conversation_id`: rename maps onto the generic CRUD update,
        // which reads the row id from `id`.
        await fetchNui('renameConversation', { id: conversationId, name });
      } catch (e) {
        console.error('Failed to rename conversation', e);
      }
    },

    addReceivedMessage: (incoming: {
      conversation_id?: number;
      message?: string;
      senderName?: string;
      phone?: string;
      avatar?: string;
      created_at?: string;
      reply_to_id?: number | null;
    }) => {
      const convId = incoming.conversation_id || 1;
      const currentActiveId = get(activeConversationId);
      const isCurrentlyActive = currentActiveId === convId;

      update((convs) => {
        let found = false;
        const updated = convs.map((c) => {
          if (convId && c.id === convId) {
            found = true;
            return {
              ...c,
              unreadCount: isCurrentlyActive ? 0 : (c.unreadCount || 0) + 1,
              lastMessage: incoming.message || c.lastMessage,
              lastMessageAt: incoming.created_at || new Date().toISOString()
            };
          }
          return c;
        });
        if (!found && convId) {
          const newConv: UIConversation = {
            id: convId,
            citizenid: '',
            is_group: false,
            target: incoming.phone || 'unknown',
            targetName: incoming.senderName || incoming.phone || 'Unknown',
            targetAvatar: incoming.avatar,
            lastMessage: incoming.message || '',
            lastMessageAt: incoming.created_at || new Date().toISOString(),
            unreadCount: isCurrentlyActive ? 0 : 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };
          return [newConv, ...updated];
        }
        return updated.sort(
          (a, b) =>
            new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime()
        );
      });

      if (isCurrentlyActive) {
        fetchNui('readConversation', { conversation_id: convId }).catch(() => {});
      }

      messagesByConversation.update((msgs) => {
        const currentMsgs = msgs[convId];
        if (!currentMsgs) return msgs;

        // Resolved against what's already loaded, same as `sendMessage`'s optimistic append
        // and `loadMessages`'s own resolution — without it, a reply arriving live (rather
        // than via a reload) rendered with no quoted-preview banner.
        const replyToMsg = incoming.reply_to_id
          ? (currentMsgs.find((m) => m.id === incoming.reply_to_id) ?? null)
          : null;

        const newUiMsg: UIMessage = {
          id: Math.floor(Math.random() * 1000000),
          conversation_id: convId,
          citizenid: 'other-cit',
          sender: 'other',
          status: 'active',
          message: incoming.message || '',
          attachments: [],
          reply_to_id: incoming.reply_to_id,
          replyToMsg,
          created_at: incoming.created_at || new Date().toISOString(),
          updated_at: incoming.created_at || new Date().toISOString()
        };

        return {
          ...msgs,
          [convId]: [...currentMsgs, newUiMsg]
        };
      });
    }
  };
}

export const conversationsStore = createMessagesStore();

export const unreadMessagesCount = derived(
  conversationsStore,
  ($conversationsStore: UIConversation[]) =>
    $conversationsStore.reduce(
      (total: number, conv: UIConversation) => total + (conv.unreadCount || 0),
      0
    )
);
