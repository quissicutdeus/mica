import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk';

export default defineApp({
  id: 'settings',
  color: 'bg-gray-700',
  icon: Icon,
  description: 'Configure phone settings, wallpapers, and preferences',
  permissions: ['notifications']
});
