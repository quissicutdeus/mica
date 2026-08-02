import { conversationsStore, unreadMessagesCount } from '../../services/conversations';
export { unreadMessagesCount };

/**
 * OS Service Hook for accessing SMS messaging.
 */
export function useMessages() {
  return {
    conversationsStore,
    unreadMessagesCount,
    sendMessage: (conversationId: number, text: string) =>
      conversationsStore.sendMessage(conversationId, text),
    addReceivedMessage: (message: Parameters<typeof conversationsStore.addReceivedMessage>[0]) =>
      conversationsStore.addReceivedMessage(message)
  };
}
