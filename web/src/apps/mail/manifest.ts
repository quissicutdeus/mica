import Icon from './Icon.svelte';
import { defineApp, unreadMailCount } from '@gphone/sdk';

export default defineApp({
  id: 'mail',
  color: 'bg-blue-500',
  icon: Icon,
  badgeStore: unreadMailCount,
  description: 'Read and manage incoming email messages',
  permissions: ['notifications', 'network']
});
