import Icon from './Icon.svelte';
import { defineApp, pendingReportCount } from '@gphone/sdk';

export default defineApp({
  id: 'admin',
  name: 'Administration',
  color: 'bg-rose-600',
  icon: Icon,
  // Counts outstanding reports, and only falls when one is decided. Opening the app
  // does not clear it — unlike an unread count, a report stays outstanding until
  // somebody acts on it.
  badgeStore: pendingReportCount,
  description: 'Review player reports and moderate content',
  author: 'gPhone',
  // Installed like any other system app, but the home screen hides it from players
  // without an admin ace. The server gates the queue and every action independently.
  isSystem: true,
  requiresAdmin: true
});
