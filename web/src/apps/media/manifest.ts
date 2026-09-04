// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@mica/sdk/app';

export default defineApp({
  id: 'media',
  tile: { bg: 'bg-blue-500', fg: 'text-white' },
  icon: Icon,
  preload: async () => {
    const { useMedia } = await import('@mica/sdk');
    return useMedia().media.load();
  },
  description: 'View your photo gallery and shared media',
  permissions: ['app-events', 'media', 'notifications', 'reports', 'storage'],
  core: true
});
