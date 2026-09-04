// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp, lazyBadge } from '@mica/sdk/app';

export default defineApp({
  id: 'mail',
  tile: { bg: 'bg-blue-500' },
  icon: Icon,
  badgeStore: lazyBadge(async () => {
    const { unreadMailCount } = await import('@mica/sdk');
    return unreadMailCount;
  }),
  preload: async () => {
    const { useMail } = await import('@mica/sdk');
    return useMail().mailStore.load();
  },
  description: 'Read and manage incoming email messages',
  permissions: ['mail', 'notifications'],
  requiresNetwork: true,
  core: true
});
