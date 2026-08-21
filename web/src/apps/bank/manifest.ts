import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: 'bank',
  color: 'bg-purple-600',
  icon: Icon,
  description: 'Manage bank accounts and transfer funds',
  permissions: ['account'],
  requiresNetwork: true,
  core: true
});
