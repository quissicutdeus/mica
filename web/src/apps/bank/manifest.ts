// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@mica/sdk/app';

export default defineApp({
  id: 'bank',
  tile: { bg: 'bg-purple-600' },
  icon: Icon,
  description: 'Manage bank accounts and transfer funds',
  // 'notifications': the post-transfer success toast, via `usePhoneNotification`.
  // 'app-events': the server's push when a new invoice lands (MICA-240), so the list
  // re-reads while Bank is resident rather than waiting for the next foreground.
  permissions: ['account', 'bank', 'notifications', 'app-events'],
  // Every screen in here moves money, which comes from the framework bridge and is simply
  // absent in standalone mode. Distinct from the `bank` permission above: that discloses
  // what this app reaches for, this states what the server has to be able to do.
  requires: ['money'],
  requiresNetwork: true,
  core: true
});
