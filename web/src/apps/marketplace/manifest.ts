import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: 'marketplace',
  name: 'Snatchr',
  color: 'bg-amber-600',
  icon: Icon,
  description: 'Buy and sell, no names attached.',
  permissions: ['call', 'marketplace', 'media', 'messages', 'notifications', 'reports'],
  author: 'gPhone',
  core: true
});
