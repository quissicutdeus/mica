import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk';

export default defineApp({
  id: 'camera',
  name: 'Camera',
  color: 'bg-gray-200 text-gray-900',
  icon: Icon,
  description: 'Take photos and view camera preview',
  permissions: ['camera', 'storage']
});
