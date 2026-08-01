import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk';

export default defineApp({
  id: 'contacts',
  name: 'Contacts',
  color: 'bg-gray-500',
  icon: Icon,
  description: 'Manage phone address book and saved contacts',
  permissions: ['contacts']
});
