// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@gos/sdk/app';

export default defineApp({
  id: 'settings',
  tile: { bg: 'bg-gray-700' },
  icon: Icon,
  description: 'Configure phone settings and preferences',
  // The tablet ships a second root (`tablet.svelte`, MICA-261): the same panes, with the
  // list left and the pane itself right, rather than the phone's drill-in. Every setting
  // Settings owns is per player, not per device, so there is nothing here the wide frame
  // cannot show.
  devices: ['phone', 'tablet'],
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
  // grant.
  //
  // `app-registry`/`clock`/`display`/`keybinds`/`notification-settings`/`system-hardware`/
  // `theme`/`wallpaper` each split into a read half and a `-write` half (MICA-127) —
  // Settings (and, for `app-registry-write`, the Store) is the one place on the phone with
  // a real reason to hold every write half, so it declares both of each pair it touches.
  permissions: [
    'account',
    'admin',
    'app-registry',
    'app-registry-write',
    'call',
    'clock',
    'clock-write',
    'devtools',
    'display',
    'display-write',
    'keybinds',
    'keybinds-write',
    'lock-screen',
    'lock-screen-write',
    'mail',
    'media',
    'messages',
    'music',
    'navigation',
    'notifications',
    'notification-settings',
    'notification-settings-write',
    'storage',
    'system-hardware',
    'system-hardware-write',
    'theme',
    'theme-write',
    'wallpaper',
    'wallpaper-write'
  ],
  core: true
});
