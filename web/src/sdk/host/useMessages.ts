import { conversationsStore, unreadMessagesCount } from '../../services/conversations';
import { openApp } from '../../shell/state/navigation';
import { assertCapability } from '../capability';
export { unreadMessagesCount };

/**
 * OS Service Hook for accessing SMS messaging.
 */
export function useMessages() {
  assertCapability('messages', 'useMessages');
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
    startText: (phone: string) => openApp('messages', { phone, startNew: true })
  };
}
