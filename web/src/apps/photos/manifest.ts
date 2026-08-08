import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: 'photos',
  color: 'bg-blue-500 text-white',
  icon: Icon,
  preload: async () => {
    const { usePhotos } = await import('@gphone/sdk');
    return usePhotos().photos.load();
  },
  description: 'View photo gallery and captured images',
  permissions: ['media', 'notifications', 'storage'],
  core: true
});
