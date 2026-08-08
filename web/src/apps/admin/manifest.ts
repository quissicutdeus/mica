import Icon from './Icon.svelte';
import { defineApp, lazyBadge } from '@gphone/sdk/app';

export default defineApp({
  id: 'admin',
  color: 'bg-rose-600',
  icon: Icon,
  // Counts outstanding reports, and only falls when one is decided. Opening the app
  // does not clear it — unlike an unread count, a report stays outstanding until
  // somebody acts on it.
  badgeStore: lazyBadge(async () => {
    const { pendingReportCount } = await import('@gphone/sdk');
    return pendingReportCount;
  }),
  preload: async () => {
    const { useReports } = await import('@gphone/sdk');
    return useReports().loadPendingReports();
  },
  description: 'Review player reports and moderate content',
  author: 'gPhone',
  // Installed like any other core app, but the home screen hides it from players
  // without an admin ace. The server gates the queue and every action independently.
  core: true,
  requiresAdmin: true
});
