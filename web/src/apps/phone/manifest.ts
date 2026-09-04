// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@mica/sdk/app';

export default defineApp({
  id: 'phone',
  tile: { bg: 'bg-green-500' },
  icon: Icon,
  description: 'Make phone calls and view call history',
  permissions: ['call', 'contacts', 'notifications'],
  requiresNetwork: true,
  core: true
});
