import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk';

export default defineApp({
  id: 'marketplace',
  color: 'bg-amber-600',
  icon: Icon,
  description: 'Buy and sell, no names attached.',
  permissions: [],
  author: 'gPhone',
  core: true
});
