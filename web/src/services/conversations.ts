// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable, derived, get } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import { call, callOr } from '../nui/call';
import { conversationsContract } from '@gphone/shared/contracts/conversations';
import { messagesContract } from '@gphone/shared/contracts/messages';
import type { Contact, Conversation } from '@gphone/shared/types';
import type { UIConversation, UIMessage } from '@gphone/sdk';
import { byNewest } from '../../../sdk/createCrudStore';
import { createPagedStore, type PageReader } from '../../../sdk/createPagedStore';
import { createReactionStore } from '../../../sdk/kit/createReactionStore';

import { citizenid, fetchCitizenId } from './account';
import { contacts } from './contacts';

/**
 * One server page of threads.
 *
 * Matched to `conversations`' own `paging.pageSize` in `server/services/Conversations.ts`
 * (200, and `maxPageSize` is the same number, so the server would clamp anything larger).
 * Deliberately *not* smaller, which is the tempting change and the wrong one:
 * `ConversationRepository.findForCitizen` walks the keyset on `c.id DESC`, and the inbox is
 * ordered by *recency of the last message*, which is a different order. An old thread
 * someone still texts daily has a low id and a recent `lastMessageAt`, so with a page
 * smaller than the whole list it would be missing from the top of the inbox until enough
 * pages had been loaded to reach it. At 200 the cursor only engages past the point the
 * server already truncated at, so no player's inbox order changes and the >200 case goes
 * from "silently unreachable forever" to "one more page away". Lowering this needs the
 * server to page on last-message recency first.
 */
const CONVERSATION_PAGE_SIZE = 200;

/**
 * How many opened threads keep their messages in memory. Beyond this the least recently
 * opened is dropped.
 *
 * The same argument `MAX_RESIDENT_APPS` makes for app components in
 * `web/src/shell/state/navigation.ts`, one level down: unbounded caching is a slow leak
 * whose cost nobody can state. Every thread ever opened used to be held in full for the
 * whole session — a group chat with a thousand messages stayed resident because it was
 * looked at once — and a cap is what makes the ceiling knowable.
 *
 * Five, and the same five, because both are answering the same question: how many of these
 * does a player actually flip between before the next one is a fresh read anyway. Dropping
 * a thread costs one `getMessages` round trip when it is next opened, which is exactly what
 * opening it the first time cost.
 *
 * Nothing reads a dropped thread by surprise: `addReceivedMessage` appends only to a thread
 * already held (a message for an uncached thread updates the *inbox row* and is picked up
 * by the refetch on open), and `syncConversationPreview` returns early for one it has not
 * got.
 */
const MAX_CACHED_THREADS = 5;

/** Resolve display info for one conversation against the caller and their address book. */
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

/**
 * One page of the inbox, mapped for display.
 *
 * A reader rather than handing `createPagedStore` an action name, because the rows need the
 * caller's citizenid and address book folded in before anything can render them, and that is
 * a mapping step the factory has no hook for. Since MICA-213 the reader makes the typed
 * `call(conversationsContract, 'get', ...)`, so there is no action name for either the
 * factory or `server/__tests__/routes.test.ts` to read as a route — the contract is what the
 * suite holds the call site to instead.
 *
 * **The cursor is derived, because the server still answers a bare array.** MICA-197 made
 * `conversations:get` *accept* `{ limit, cursor }` (`pageBounds`, keyset on `c.id DESC`, the
 * cursor a bare row id) without changing the reply shape, so "is there another page" has to
 * be inferred: a page that came back short of the limit is the last one, and otherwise the
 * lowest id in it — the final row, in `id DESC` — is where the next page starts. The cost of
 * inferring rather than being told is one empty request when the list divides exactly by the
 * page size; `loadMore` sees zero rows, reports false and clears `hasMore`, so it
 * self-corrects rather than looping.
 *
 * No `defaultValue`, following `createPagedStore`'s contract and `accounts.ts`'s note on the
 * same point: a transport failure throws so `load` can keep the window it is already
 * holding. This is a change from the hand-written loader, which passed `[]` and blanked a
 * populated inbox whenever a background refresh failed.
 */
const readConversationPage: PageReader<UIConversation> = async (payload) => {
  let myId = get(citizenid);
  if (!myId) myId = await fetchCitizenId();
  const currentContacts = get(contacts);

  // `PageReader` hands its payload as an untyped bag; `createPagedStore` builds it as
  // `{ ...filter, cursor, limit }`, which is exactly what the contract declares.
  const data = await call(
    conversationsContract,
    'get',
    payload as { cursor?: number | null; limit?: number }
  );
  const raw = Array.isArray(data) ? data : [];

  const rows: UIConversation[] = raw.map((c) => {
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

  const limit = typeof payload.limit === 'number' ? payload.limit : CONVERSATION_PAGE_SIZE;
  const nextCursor = raw.length < limit ? null : (raw[raw.length - 1]?.id ?? null);

  return { rows, nextCursor };
};

function createMessagesStore() {
  const list = createPagedStore<UIConversation>(readConversationPage, {
    pageSize: CONVERSATION_PAGE_SIZE
  });

  /**
   * The inbox order, in one place.
   *
   * It used to be the same comparator written out at three call sites — the initial load,
   * the optimistic bump after sending, and the one after a message arrived — which is three
   * chances for them to disagree and no way to notice when they did. Sorting the window here
   * instead of at each mutation means every path that can reorder the inbox goes through it,
   * including the ones nobody thought about: `startConversation`'s prepend, a rename, a page
   * appended by `loadMore`.
   *
   * `byNewest` is the SDK's own comparator (`sdk/createCrudStore.ts`), so the phone has one
   * definition of "newest first" rather than a second one that happens to agree. It is also
   * stricter than what it replaces: `new Date(undefined).getTime()` is `NaN`, which makes a
   * row with no timestamp sort unpredictably, where `byNewest` floors it at the epoch.
   *
   * Note that this is the *display* order and the server's paging order is `id DESC` — see
   * `CONVERSATION_PAGE_SIZE` for why that difference is what pins the page size.
   */
  const ordered = derived(list, ($rows) =>
    [...$rows].sort(byNewest<UIConversation>('lastMessageAt'))
  );

  /** Messages of the threads currently held, keyed by conversation id. */
  const messagesByConversation = writable<Record<number, UIMessage[]>>({});
  const activeConversationId = writable<number | null>(null);

  /**
   * Held thread ids, least recently opened first.
   *
   * Beside the cache rather than as its order, for the reason `navigation.ts` gives about
   * `runningApps`: eviction wants recency, and a `Record` has no order worth relying on.
   */
  let threadRecency: number[] = [];

  const dropThreads = (ids: number[]) => {
    if (ids.length === 0) return;
    const doomed = new Set(ids);
    threadRecency = threadRecency.filter((id) => !doomed.has(id));
    messagesByConversation.update((msgs) => {
      const kept: Record<number, UIMessage[]> = {};
      for (const [key, value] of Object.entries(msgs)) {
        if (!doomed.has(Number(key))) kept[Number(key)] = value;
      }
      return kept;
    });
  };

  /**
   * Mark a thread as the most recently opened, and evict past the cap.
   *
   * The active thread is always the one just touched, so the least-recently-opened end can
   * never be what the player is looking at.
   */
  const touchThread = (conversationId: number) => {
    threadRecency = [...threadRecency.filter((id) => id !== conversationId), conversationId];
    if (threadRecency.length > MAX_CACHED_THREADS) {
      dropThreads(threadRecency.slice(0, threadRecency.length - MAX_CACHED_THREADS));
    }
  };

  /**
   * Patch one inbox row.
   *
   * `createPagedStore` exposes `replace(row)` rather than a field-wise patch, so the row is
   * read back first. Sorting is not this function's business — `ordered` above re-derives it
   * from whatever the window now holds.
   */
  const patchConversation = (conversationId: number, changes: Partial<UIConversation>) => {
    const row = get(list).find((c) => c.id === conversationId);
    if (row) list.replace({ ...row, ...changes });
  };

  /**
   * Re-derive a conversation's list preview from the thread as it now stands.
   *
   * Editing or unsending the newest message changes what the inbox row should say, and
   * the row keeps its own denormalised copy (`lastMessage`, `last_message`) so the list
   * can render without every thread being loaded. Without this, unsending your last text
   * leaves the inbox quoting a message that is no longer in the conversation.
   *
   * The sort order is deliberately left alone: `lastMessageAt` still names when the last
   * message was *sent*, and fixing a typo is not a reason for a thread to jump the list.
   */
  const syncConversationPreview = (conversationId: number) => {
    const held = get(messagesByConversation)[conversationId];
    if (!held) return;
    const last = held[held.length - 1];

    patchConversation(conversationId, {
      lastMessage: last?.message ?? '',
      ...(last?.created_at ? { lastMessageAt: last.created_at as string } : {}),
      last_message: last
    });
  };

  return {
    subscribe: ordered.subscribe,
    loaded: list.loaded,
    /** Whether the server said there is another page of threads behind this one. */
    hasMore: list.hasMore,
    // Undeclared on `Facets['messages']` too — see `loadMoreConversations` below.
    messages: { subscribe: messagesByConversation.subscribe },
    activeConversationId: { subscribe: activeConversationId.subscribe },

    setActiveConversationId: (id: number | null) => activeConversationId.set(id),

    /**
     * Refetch the inbox, and give back every held thread but the one on screen.
     *
     * The release rides here rather than on a hook of its own because there is no
     * backgrounding edge to hang it on: `sdk/host/lifecycle.ts` offers `onAppForeground` and
     * no counterpart, and apps are resident rather than unmounted, so "the player left
     * Messages" is not an event an app can observe. Refetching is the honest substitute — a
     * held thread is stale the moment the list it belongs to is being revalidated, and every
     * caller of this is a moment when that is true: Messages coming back to the front,
     * Contacts refreshing after an edit, the launcher preloading the badge.
     *
     * The active thread survives because it is what is rendered; dropping it would blank a
     * conversation the player is still looking at until the refetch landed. Everything else
     * costs one `getMessages` round trip when it is next opened, which is what opening it
     * the first time cost.
     */
    loadConversations: () => {
      const active = get(activeConversationId);
      dropThreads(threadRecency.filter((id) => id !== active));
      return list.load();
    },

    /**
     * Append the next page of threads. Returns whether anything arrived.
     *
     * Not reachable from an app yet: `Facets['messages']` in `sdk/host/facets.ts` spells the
     * conversations store out member by member, and this one is not in it, so `useMessages()`
     * cannot see it. The store half is done and tested; the inbox will only *offer* a "load
     * older conversations" control once that declaration gains `hasMore` and this — a
     * `sdk/` change, and a different review.
     */
    loadMoreConversations: () => list.loadMore(),

    loadMessages: async (conversationId: number) => {
      activeConversationId.set(conversationId);
      let myId = get(citizenid);
      if (!myId) myId = await fetchCitizenId();

      const data = await callOr(messagesContract, 'get', { conversation_id: conversationId }, []);
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

      /**
       * The whole thread, still — there is no cursor to ask for less.
       *
       * `messages:get` (`server/services/Messages.ts`) reads only `conversationIdFrom(data)`
       * and hands back `findByConversation`'s entire result; it declares no `paging`, so
       * unlike `conversations:get` there is nothing here to page against. The Messages app
       * windows the *rendering* with `usePagedList`, which keeps the DOM bounded but not the
       * transfer or this cache, and `MAX_CACHED_THREADS` bounds how many whole threads are
       * held at once rather than how large any one of them is.
       *
       * Paging inside a thread therefore needs the server half first: `paging` on the
       * `messages` service and `pageBounds` in that handler, the way MICA-197 did it for
       * conversations, after which this becomes a second `createPagedStore` with the cursor
       * walking `id DESC` from the newest message backwards. That is a `server/` change and
       * is deliberately out of MICA-204's scope — it is the follow-up to file, not an
       * oversight here.
       */
      touchThread(conversationId);
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
        const sent = await call(messagesContract, 'send', payload);
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

        // Update conversation last message snippet (optimistic). `ordered` sorts it to the
        // top; the bump no longer needs a comparator of its own.
        patchConversation(conversationId, {
          lastMessage: sent.message,
          lastMessageAt: sent.created_at as string,
          last_message: sent
        });

        return sent;
      } catch (e) {
        console.error('Failed to send message:', e);
        throw e;
      }
    },

    /**
     * Rewrite a message you sent.
     *
     * Server first, then the store — the opposite of `archiveConversation` and friends
     * above, and deliberately. Those change what only the caller sees, so an optimistic
     * write that later fails is a cosmetic lie; this one changes what the *other party*
     * reads, and showing the corrected text before the server has taken it would be
     * claiming a thing was fixed when it may not have been.
     *
     * `edited` is applied only when the reply says so. The server omits it when the text
     * came back unchanged — saving the same words is not an edit and must not raise the
     * marker.
     */
    editMessage: async (conversationId: number, messageId: number, message: string) => {
      // Cast because `messages.edit` declares `output: responseType<{ ok: boolean }>()` while
      // the handler answers the saved row — see this file's note in the MICA-213 report.
      const saved = (await call(messagesContract, 'edit', {
        id: messageId,
        message
      })) as unknown as { message: string; edited?: boolean } | null;
      if (!saved) return null;

      messagesByConversation.update((msgs) => {
        const held = msgs[conversationId];
        if (!held) return msgs;
        return {
          ...msgs,
          [conversationId]: held.map((m) =>
            m.id === messageId
              ? { ...m, message: saved.message, edited: m.edited || saved.edited === true }
              : m
          )
        };
      });

      syncConversationPreview(conversationId);
      return saved;
    },

    /**
     * Unsend a message you sent — for everyone, not just for you.
     *
     * The row is soft-deleted server-side and filtered out of every participant's fetch,
     * so removing it from the local thread is the same outcome the next reload produces
     * rather than a local-only hide. Nothing is optimistic here for the same reason as
     * `editMessage`: a message that reappears on the next open is worse than one that
     * takes a moment to go.
     */
    deleteMessage: async (conversationId: number, messageId: number) => {
      const removed = await call(messagesContract, 'delete', { id: messageId });
      if (!removed) return false;

      messagesByConversation.update((msgs) => {
        const held = msgs[conversationId];
        if (!held) return msgs;
        return { ...msgs, [conversationId]: held.filter((m) => m.id !== messageId) };
      });

      syncConversationPreview(conversationId);
      return true;
    },

    startConversation: async (phone: string, isGroup: boolean = false) => {
      const myId = get(citizenid);
      const currentContacts = get(contacts);

      try {
        const newConv = await call(conversationsContract, 'create', {
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

        list.prepend(mapped);
        return mapped;
      } catch (e) {
        console.error('Failed to start conversation', e);
        throw e;
      }
    },

    markAsRead: async (conversationId: number) => {
      patchConversation(conversationId, { unreadCount: 0 });
      try {
        await call(conversationsContract, 'read', { conversation_id: conversationId });
      } catch (e) {
        console.error('Failed to mark conversation read', e);
      }
    },

    archiveConversation: async (conversationId: number, archive: boolean = true) => {
      const nextStatus = archive ? 'archived' : 'active';
      patchConversation(conversationId, { status: nextStatus });
      try {
        await call(conversationsContract, 'archive', {
          conversation_id: conversationId,
          status: nextStatus
        });
      } catch (e) {
        console.error('Failed to archive conversation', e);
      }
    },

    deleteConversation: async (conversationId: number) => {
      list.remove(conversationId);
      // The thread cannot be reopened, so holding its messages is pure cost.
      dropThreads([conversationId]);
      try {
        await call(conversationsContract, 'delete', { conversation_id: conversationId });
      } catch (e) {
        console.error('Failed to delete conversation', e);
      }
    },

    renameConversation: async (conversationId: number, name: string) => {
      patchConversation(conversationId, { name, targetName: name });
      try {
        // `id`, not `conversation_id`: rename maps onto the generic CRUD update,
        // which reads the row id from `id`.
        await fetchNui('renameConversation', { id: conversationId, name });
      } catch (e) {
        console.error('Failed to rename conversation', e);
      }
    },

    addReceivedMessage: (incoming: {
      /** The stored row's id. The live push carries it; a caller without one gets a placeholder. */
      id?: number;
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

      const existing = get(list).find((c) => c.id === convId);
      if (existing) {
        list.replace({
          ...existing,
          unreadCount: isCurrentlyActive ? 0 : (existing.unreadCount || 0) + 1,
          lastMessage: incoming.message || existing.lastMessage,
          lastMessageAt: incoming.created_at || new Date().toISOString()
        });
      } else {
        // A thread the inbox has never seen — the push is the first thing the phone knows
        // about it. Enough of a row to render until the next `loadConversations` replaces
        // it with the server's.
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
        list.prepend(newConv);
      }

      if (isCurrentlyActive) {
        call(conversationsContract, 'read', { conversation_id: convId }).catch(() => {});
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

        // The real row id when the push carries one — a reaction or delete keyed on an
        // invented id can land on somebody else's message. The placeholder survives only
        // for a caller that has no row to name.
        const newUiMsg: UIMessage = {
          id: incoming.id ?? Math.floor(Math.random() * 1000000),
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

/**
 * Reactions on a message, on the shared primitive (MICA-98/MICA-143).
 *
 * `gphone_messages_reactions` is its own child table under the `messages` service, keyed on
 * citizenid rather than an account — see `Messages.ts`'s docblock above
 * `requireReactableMessage` for why this is not `gphone_account_reactions`. Messages is core,
 * so this reaches the server through the typed `call` against `messagesContract`
 * (`react`/`unreact`/`reactionsFor`) exactly like the rest of this file, rather than through a
 * facet the way Blabber's `dmReactions` must for a `core: false` add-on.
 *
 * A group thread's count is not treated any differently from a DM's here or in `ReactionBar` —
 * both render a bare count plus whether the caller is one of the reactors, and that is
 * participant-count agnostic by construction (see `ReactionBar`'s own docblock: it holds no
 * state about *who* reacted, only how many and whether "mine"). Surfacing *which* participants
 * reacted would need the server to hand back identities rather than counts, which is a wider
 * contract change than this ticket's "point Messages at the existing primitive" — so a group
 * thread with three reactions today reads exactly like a DM with three would, and that is the
 * deliberate scope of this pass rather than an oversight.
 */
export const messageReactions = createReactionStore({
  load: (ids) => callOr(messagesContract, 'reactionsFor', { target_ids: ids }, {}),
  react: (messageId, emoji) => call(messagesContract, 'react', { message_id: messageId, emoji }),
  unreact: (messageId, emoji) => call(messagesContract, 'unreact', { message_id: messageId, emoji })
});

export const toggleMessageReaction = (messageId: number, emoji: string): Promise<void> =>
  messageReactions.toggle(messageId, emoji);
