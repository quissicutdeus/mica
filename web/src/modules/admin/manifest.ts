import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk';

export default defineApp({
  id: 'admin',
  name: 'Administration',
  color: 'bg-rose-600',
  icon: Icon,
  description: 'Review player reports and moderate content',
  author: 'gPhone',
  // Installed like any other system app, but the home screen hides it from players
  // without an admin ace. The server gates the queue and every action independently.
  isSystem: true,
  requiresAdmin: true
});
