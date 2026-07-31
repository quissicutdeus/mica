import Icon from './Icon.svelte';
import { defineApp, unreadMessagesCount } from '@gphone/sdk';

export default defineApp({
  id: 'messages',
  name: 'Messages',
  color: 'bg-green-400',
  icon: Icon,
  badgeStore: unreadMessagesCount,
  description: 'Send text messages and share content with contacts',
  permissions: ['notifications', 'contacts']
});
