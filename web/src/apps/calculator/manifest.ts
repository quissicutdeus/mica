import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: 'calculator',
  color: 'bg-gray-800',
  icon: Icon,
  description: 'Perform basic mathematical calculations',
  permissions: ['sound'],
  core: true
});
