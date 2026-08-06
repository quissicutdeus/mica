import { derived } from 'svelte/store';
import Icon from './Icon.svelte';
import { defineApp, lazyBadge, useBlabber, useNotifications } from '@gphone/sdk';

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
   * Mentions, unread DMs, and this app's persistent notifications.
   *
   * Composed here rather than handed over finished by the SDK. It used to be a
   * `blabberTotalUnread` store exported from `@gphone/sdk`, which meant the contract every
   * app builds against held a hardcoded reference to one app's service — so an add-on the
   * SDK has never heard of could not produce a badge at all. What a badge counts is the
   * app's business; the platform only says when it may be computed.
   *
   * All three inputs are generic: `useNotifications(id)` counts unread rows for any app id,
   * and the other two come from this app's own hook.
   *
   * `lazyBadge` because a manifest is evaluated while the SDK barrel is still initializing
   * — calling a hook out here directly throws `useBlabber is not a function`.
   */
  badgeStore: lazyBadge(() => {
    const { unreadMentions, unreadDms } = useBlabber();
    const { unreadCount } = useNotifications('blabber');
    return derived(
      [unreadMentions, unreadDms, unreadCount],
      ([mentions, dms, notifications]) => mentions + dms + notifications
    );
  }),
  // Required alongside a badgeStore (`sdk/appContract.test.ts`): the count has to be correct
  // *before* the launcher paints, and `onAppForeground` is too late by definition.
  preload: () => useBlabber().loadMyAccounts()
});
