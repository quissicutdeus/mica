import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: 'media',
  color: 'bg-blue-500 text-white',
  icon: Icon,
  preload: async () => {
    const { useMedia } = await import('@gphone/sdk');
    return useMedia().media.load();
  },
  description: 'View your photo gallery and shared media',
  permissions: ['media', 'notifications', 'storage'],
  core: true
});
