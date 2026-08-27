import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: 'calculator',
  tile: { bg: 'bg-gray-800' },
  icon: Icon,
  description: 'Perform basic mathematical calculations',
  core: true
});
