import Icon from './Icon.svelte';
import { defineApp, lazyBadge } from '@gphone/sdk/app';

export default defineApp({
  id: 'messages',
  color: 'bg-green-400',
  icon: Icon,
  badgeStore: lazyBadge(async () => {
    const { unreadMessagesCount } = await import('@gphone/sdk');
    return unreadMessagesCount;
  }),
  preload: async () => {
    const { useMessages } = await import('@gphone/sdk');
    return useMessages().conversationsStore.loadConversations();
  },
  description: 'Send text messages and share content with contacts',
  permissions: ['contacts', 'media', 'notifications', 'network', 'location'],
  core: true
});
