import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: 'contacts',
  color: 'bg-gray-500',
  icon: Icon,
  preload: async () => {
    const { useContacts } = await import('@gphone/sdk');
    return useContacts().contactsStore.load();
  },
  description: 'Manage phone address book and saved contacts',
  permissions: ['contacts', 'media', 'notifications', 'bluetooth'],
  core: true
});
