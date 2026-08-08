import Icon from './Icon.svelte';
import { defineApp, lazyBadge } from '@gphone/sdk/app';

export default defineApp({
  id: 'mail',
  color: 'bg-blue-500',
  icon: Icon,
  badgeStore: lazyBadge(async () => {
    const { unreadMailCount } = await import('@gphone/sdk');
    return unreadMailCount;
  }),
  preload: async () => {
    const { useMail } = await import('@gphone/sdk');
    return useMail().mailStore.load();
  },
  description: 'Read and manage incoming email messages',
  permissions: ['notifications', 'network'],
  core: true
});
