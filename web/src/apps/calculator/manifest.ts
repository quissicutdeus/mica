// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@gos/sdk/app';

export default defineApp({
  id: 'calculator',
  tile: { bg: 'bg-gray-800' },
  icon: Icon,
  description: 'Perform basic mathematical calculations',
  core: true
});
