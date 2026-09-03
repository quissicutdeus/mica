// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@gos/sdk/app';

export default defineApp({
  id: 'snek',
  tile: { bg: 'bg-yellow-500' },
  icon: Icon,
  description: 'Retro snake, gOS style',
  permissions: ['highscores', 'storage'],
  author: 'gOS',
  // Required. `false` makes this an add-on: absent from the launcher, offered by the
  // Store, and uninstallable. Set it to `true` only for something that ships with the
  // phone and must not be removable.
  core: false
});
