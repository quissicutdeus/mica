import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: 'phone',
  color: 'bg-green-500',
  icon: Icon,
  description: 'Make phone calls and view call history',
  permissions: ['contacts', 'notifications'],
  core: true
});
