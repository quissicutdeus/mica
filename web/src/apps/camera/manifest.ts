import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: 'camera',
  tile: { bg: 'bg-gray-200', fg: 'text-gray-900' },
  icon: Icon,
  description: 'Take photos and view camera preview',
  permissions: ['camera', 'keybinds', 'media', 'navigation', 'notifications', 'storage'],
  core: true
});
