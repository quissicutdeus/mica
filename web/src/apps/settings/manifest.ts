import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: 'settings',
  tile: { bg: 'bg-gray-700' },
  icon: Icon,
  description: 'Configure phone settings and preferences',
  // `storage` because the Apps pane reads and clears what other apps have stored, `media`
  // because Display/Wallpaper accesses photos for wallpaper previews, and `music` because
  // Sound owns the music channel's volume and mute — the level and the switch, never the
  // transport.
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
    'music',
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
