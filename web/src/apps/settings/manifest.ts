import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: 'settings',
  color: 'bg-gray-700',
  icon: Icon,
  description: 'Configure phone settings and preferences',
  // `storage` because the Apps pane reads and clears what other apps have stored, and `media`
  // because Display/Wallpaper accesses photos for wallpaper previews.
  permissions: [
    'account',
    'admin',
    'app-registry',
    'call',
    'clock',
    'devtools',
    'display',
    'keybinds',
    'mail',
    'media',
    'messages',
    'navigation',
    'notifications',
    'notification-settings',
    'storage',
    'system-hardware',
    'theme',
    'wallpaper'
  ],
  core: true
});
