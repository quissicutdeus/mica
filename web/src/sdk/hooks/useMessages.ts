import { messagesStore } from '../../store/messages';

/**
 * OS Service Hook for accessing SMS messaging.
 */
export function useMessages() {
  return {
    messagesStore,
    sendMessage: (conversationId: number, text: string) =>
      messagesStore.sendMessage(conversationId, text),
    addReceivedMessage: (message: any) => messagesStore.addReceivedMessage(message)
  };
}
