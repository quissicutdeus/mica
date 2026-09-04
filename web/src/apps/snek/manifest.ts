// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@mica/sdk/app';

export default defineApp({
  id: 'snek',
  tile: { bg: 'bg-yellow-500' },
  icon: Icon,
  description: 'Retro snake, micaOS style',
  permissions: ['highscores', 'storage'],
  author: 'micaOS',
  // Required. `false` makes this an add-on: absent from the launcher, offered by the
  // Store, and uninstallable. Set it to `true` only for something that ships with the
  // phone and must not be removable.
  core: false
});
