// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp, lazyBadge } from '@mica/sdk/app';

export default defineApp({
  id: 'glimpse',
  // A dark tile, so no `fg`: the glyph's near-white default reads on it (MICA-88).
  tile: { bg: 'bg-rose-600' },
  icon: Icon,
  description: 'Share photos from your gallery and follow other players',
  author: 'micaOS',
  // An add-on (MICA-253): absent from the launcher until installed from the Store, and run
  // in the sandboxed frame. Phone-only — no `devices`, because there is no tablet layout.
  core: false,
  // Blabber's set, for the same reasons: the comment and mention pushes (`app-events`,
  // `notifications`), the gallery picker and the carousel (`media`), the report dialog
  // (`reports`), handles, follows and ❤️ (`social`), the remembered account (`storage`).
  permissions: ['app-events', 'media', 'notifications', 'reports', 'social', 'storage'],
  requiresNetwork: true,
  /**
   * This app's unread persistent notifications — a comment on your post, a mention — and
   * nothing added to them, for Blabber's reason: every push that notifies already wrote a row.
   * `lazyBadge` because a manifest is evaluated while the SDK barrel is still initializing.
   */
  badgeStore: lazyBadge(async () => {
    const { useNotifications } = await import('@mica/sdk');
    return useNotifications('glimpse').unreadCount;
  }),
  // Required alongside a badgeStore (`sdk/appContract.test.ts`).
  preload: () => import('./store').then((m) => m.loadMyAccounts())
});
