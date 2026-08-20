import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: 'hodlr',
  name: 'Hodlr',
  color: 'bg-emerald-600',
  icon: Icon,
  description: 'Trade gCoin. No questions asked.',
  permissions: [],
  core: false
});
