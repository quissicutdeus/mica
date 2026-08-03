import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk';

export default defineApp({
  id: 'photos',
  color: 'bg-blue-500 text-white',
  icon: Icon,
  description: 'View photo gallery and captured images',
  permissions: ['storage']
});
