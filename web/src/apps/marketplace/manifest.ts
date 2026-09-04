// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@mica/sdk/app';

export default defineApp({
  id: 'marketplace',
  name: 'Snatchr',
  tile: { bg: 'bg-amber-600' },
  icon: Icon,
  description: 'Buy and sell, no names attached.',
  permissions: ['call', 'marketplace', 'media', 'messages', 'notifications', 'reports'],
  author: 'micaOS',
  core: true
});
