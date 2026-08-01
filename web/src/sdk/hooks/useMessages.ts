import { conversationsStore, unreadMessagesCount } from '../../services/conversations';
export { conversationsStore, unreadMessagesCount };

/**
 * OS Service Hook for accessing SMS messaging.
 */
export function useMessages() {
  return {
    conversationsStore,
    unreadMessagesCount,
    sendMessage: (conversationId: number, text: string) =>
      conversationsStore.sendMessage(conversationId, text),
    addReceivedMessage: (message: any) => conversationsStore.addReceivedMessage(message)
  };
}
