import Icon from './Icon.svelte';
import { defineApp, usePhotos } from '@gphone/sdk';

export default defineApp({
  id: 'photos',
  color: 'bg-blue-500 text-white',
  icon: Icon,
  preload: () => usePhotos().photos.load(),
  description: 'View photo gallery and captured images',
  permissions: ['storage']
});
