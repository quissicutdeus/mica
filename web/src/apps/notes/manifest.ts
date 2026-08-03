import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk';

export default defineApp({
  id: 'notes',
  color: 'bg-yellow-400',
  icon: Icon,
  description: 'Create and store personal notes',
  permissions: ['storage'],
  author: 'Community',
  isSystem: false
});
