import Icon from './Icon.svelte';
import { defineApp, useMessages, unreadMessagesCount } from '@gphone/sdk';

export default defineApp({
  id: 'messages',
  color: 'bg-green-400',
  icon: Icon,
  badgeStore: unreadMessagesCount,
  preload: () => useMessages().conversationsStore.loadConversations(),
  description: 'Send text messages and share content with contacts',
  permissions: ['notifications', 'contacts']
});
