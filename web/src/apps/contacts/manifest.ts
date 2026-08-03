import Icon from './Icon.svelte';
import { defineApp, useContacts } from '@gphone/sdk';

export default defineApp({
  id: 'contacts',
  color: 'bg-gray-500',
  icon: Icon,
  preload: () => useContacts().contactsStore.load(),
  description: 'Manage phone address book and saved contacts',
  permissions: ['contacts']
});
