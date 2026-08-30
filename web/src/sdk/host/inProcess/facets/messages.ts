import { registerFacet } from '../../current';
import {
  conversationsStore,
  unreadMessagesCount,
  messageReactions,
  toggleMessageReaction
} from '../../../../services/conversations';
import { openApp } from '../../../../shell/state/navigation';
export { unreadMessagesCount };

/**
 * OS Service Hook for accessing SMS messaging.
 */
export function messages() {
  return {
    conversationsStore,
    unreadMessagesCount,
    sendMessage: (conversationId: number, text: string) =>
      conversationsStore.sendMessage(conversationId, text),
    addReceivedMessage: (message: Parameters<typeof conversationsStore.addReceivedMessage>[0]) =>
      conversationsStore.addReceivedMessage(message),
    /**
     * Open Messages and start (or resume) a conversation with a bare phone number —
     * no saved Contact required. See MICA-15.
     */
    startText: (phone: string) => openApp('messages', { phone, startNew: true }),
    /** Reactions on a message (MICA-143), on the shared primitive — see `conversations.ts`. */
    messageReactions,
    loadMessageReactions: (ids: number[]) => messageReactions.load(ids),
    toggleMessageReaction: (messageId: number, emoji: string) =>
      toggleMessageReaction(messageId, emoji)
  };
}

registerFacet('messages', messages);
