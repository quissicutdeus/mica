import { messagesStore, unreadMessagesCount } from '../../store/messages';
export { messagesStore, unreadMessagesCount };

/**
 * OS Service Hook for accessing SMS messaging.
 */
export function useMessages() {
  return {
    messagesStore,
    unreadMessagesCount,
    sendMessage: (conversationId: number, text: string) =>
      messagesStore.sendMessage(conversationId, text),
    addReceivedMessage: (message: any) => messagesStore.addReceivedMessage(message)
  };
}
