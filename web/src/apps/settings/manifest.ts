import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk';

export default defineApp({
  id: 'settings',
  color: 'bg-gray-700',
  icon: Icon,
  description: 'Configure phone settings, wallpapers, and preferences',
  // `storage` because the Apps pane reads and clears what other apps have stored, which is a
  // wider reach than an app keeping its own preferences and is the half worth disclosing.
  permissions: ['notifications', 'storage'],
  core: true
});
