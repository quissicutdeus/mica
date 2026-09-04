// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@mica/sdk/app';

export default defineApp({
  id: 'hodlr',
  name: 'Hodlr',
  tile: { bg: 'bg-emerald-600' },
  icon: Icon,
  description: 'Trade gCoin. No questions asked.',
  permissions: [],
  // Buying and selling gCoin is a currency transfer, so a server with no framework behind
  // it cannot honour a single action in this app.
  requires: ['money'],
  core: false
});
