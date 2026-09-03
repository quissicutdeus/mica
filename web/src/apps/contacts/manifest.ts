// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@gos/sdk/app';

export default defineApp({
  id: 'contacts',
  tile: { bg: 'bg-gray-500' },
  icon: Icon,
  preload: async () => {
    const { useContacts } = await import('@gos/sdk');
    return useContacts().contactsStore.load();
  },
  description: 'Manage phone address book and saved contacts',
  permissions: [
    'call',
    'contacts',
    'media',
    'messages',
    'navigation',
    'notifications',
    'system-hardware'
  ],
  core: true
});
