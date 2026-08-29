import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: 'settings',
  tile: { bg: 'bg-gray-700' },
  icon: Icon,
  description: 'Configure phone settings and preferences',
  // `storage` because the Apps pane reads and clears what other apps have stored, `media`
  // because Display/Wallpaper accesses photos for wallpaper previews, and `music` because
  // Sound owns the music channel's volume and mute.
  //
  // This list is a list of *grants*, not of usage, and the two are not the same size.
  // `sdk/permissions.ts` maps one permission per hook — `useMusic: 'music'` — so declaring
  // `music` hands Settings the whole facet, `playSource`/`pauseMusic`/`stopMusic` and the
  // nearby-broadcast surface included, even though Sound touches only the level and the
  // mute. That is the honest direction to err in: §7 allows declaring more than the scan
  // finds and forbids declaring less, and the permission sheet a player reads shows the
  // grant. The same holds for `system-hardware`, which covers the battery, the signal,
  // Bluetooth, the volume and the ringer switch as one.
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
