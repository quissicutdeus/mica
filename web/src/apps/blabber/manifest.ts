import Icon from './Icon.svelte';
import { defineApp, blabberTotalUnread, useBlabber } from '@gphone/sdk';

export default defineApp({
  id: 'blabber',
  color: 'bg-sky-500',
  icon: Icon,
  description: 'Post short updates and follow other players',
  author: 'gPhone',
  // An add-on: absent from the launcher until installed from the Store. The first real
  // non-core app, and the first genuine listing the Store has ever had.
  core: false,
  permissions: ['notifications', 'media', 'storage'],
  /**
   * Combined unread count (mentions, DMs, persistent notifications).
   */
  badgeStore: blabberTotalUnread,
  // Required alongside a badgeStore (`sdk/appContract.test.ts`): the count has to be correct
  // *before* the launcher paints, and `onAppForeground` is too late by definition.
  preload: () => useBlabber().loadMyAccounts()
});
