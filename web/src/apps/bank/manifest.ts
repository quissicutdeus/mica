import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: 'bank',
  tile: { bg: 'bg-purple-600' },
  icon: Icon,
  description: 'Manage bank accounts and transfer funds',
  // 'notifications': the post-transfer success toast, via `usePhoneNotification`.
  permissions: ['account', 'bank', 'notifications'],
  requiresNetwork: true,
  core: true
});
