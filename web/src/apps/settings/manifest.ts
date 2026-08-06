import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk';

export default defineApp({
  id: 'settings',
  color: 'bg-gray-700',
  icon: Icon,
  description: 'Configure phone settings and preferences',
  // `storage` because the Apps pane reads and clears what other apps have stored, and `media`
  // because Display/Wallpaper accesses photos for wallpaper previews.
  permissions: ['notifications', 'storage', 'media'],
  core: true
});
