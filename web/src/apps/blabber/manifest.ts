import Icon from './Icon.svelte';
import { defineApp, lazyBadge } from '@gphone/sdk/app';

export default defineApp({
  id: 'blabber',
  color: 'bg-sky-500',
  icon: Icon,
  description: 'Post short updates and follow other players',
  author: 'gPhone',
  // An add-on: absent from the launcher until installed from the Store. The first real
  // non-core app, and the first genuine listing the Store has ever had.
  core: false,
  permissions: ['notifications', 'media', 'storage', 'network'],
  /**
   * This app's unread persistent notifications, and nothing added to them.
   *
   * Composed here rather than handed over finished by the SDK. It used to be a
   * `blabberTotalUnread` store exported from `@gphone/sdk`, which meant the contract every
   * app builds against held a hardcoded reference to one app's service — so an add-on the
   * SDK has never heard of could not produce a badge at all. What a badge counts is the
   * app's business; the platform only says when it may be computed.
   *
   * **One source, because every mention and DM is already a row.** This summed three stores —
   * an in-memory mention counter, the unread total derived from DM threads, and the OS count —
   * and the first two are the same events the third is counting: a mention incremented the
   * local counter *and* persisted a notification, so one mention put 2 on the launcher and one
   * DM put 2 more. The persisted count is also the only one that survives a resource restart,
   * which is what the notifications table exists for.
   *
   * `unreadDms` stays, on the header DM icon rather than here — "unread in this thread" is a
   * different question from "anything new?", and only the second belongs on a launcher badge.
   *
   * `lazyBadge` because a manifest is evaluated while the SDK barrel is still initializing
   * — calling a hook out here directly throws `useBlabber is not a function`.
   */
  badgeStore: lazyBadge(async () => {
    const { useNotifications } = await import('@gphone/sdk');
    return useNotifications('blabber').unreadCount;
  }),
  // Required alongside a badgeStore (`sdk/appContract.test.ts`): the count has to be correct
  // *before* the launcher paints, and `onAppForeground` is too late by definition.
  preload: () => import('./store').then((m) => m.loadMyAccounts())
});
