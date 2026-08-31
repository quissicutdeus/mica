import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

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
