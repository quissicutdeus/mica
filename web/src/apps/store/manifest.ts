import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk';

export default defineApp({
  id: 'store',
  color: 'bg-indigo-600',
  icon: Icon,
  author: 'gPhone',
  description: 'Browse, install, and manage gPhone community apps and permissions',
  permissions: ['storage', 'network'],
  core: true
});
