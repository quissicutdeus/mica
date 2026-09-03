// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp, lazyBadge } from '@gos/sdk/app';

export default defineApp({
  id: 'messages',
  tile: { bg: 'bg-green-400', fg: 'text-gray-900' },
  icon: Icon,
  badgeStore: lazyBadge(async () => {
    const { unreadMessagesCount } = await import('@gos/sdk');
    return unreadMessagesCount;
  }),
  preload: async () => {
    const { useMessages } = await import('@gos/sdk');
    return useMessages().conversationsStore.loadConversations();
  },
  description: 'Send text messages and share content with contacts',
  permissions: [
    'account',
    'contacts',
    'location',
    'media',
    'messages',
    'navigation',
    'notifications',
    'reports'
  ],
  requiresNetwork: true,
  core: true
});
