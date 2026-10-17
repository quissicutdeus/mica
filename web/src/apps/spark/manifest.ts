// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp, lazyBadge } from '@mica/sdk/app';

export default defineApp({
  id: 'spark',
  name: 'Spark',
  // A dark tile, so no `fg`: the glyph's near-white default reads on it (MICA-88).
  tile: { bg: 'bg-red-700' },
  icon: Icon,
  description: 'Meet other players: swipe, match, and talk once you both say yes',
  author: 'micaOS',
  // An add-on (MICA-255): absent from the launcher until installed from the Store, and run in
  // the sandboxed frame. Phone-only — no `devices`, because there is no tablet layout.
  core: false,
  // What the scan finds and nothing more: the match, unmatch and message pushes (`app-events`),
  // the gallery picker in the profile editor (`media`), the unread badge and the toasts
  // the picker and the report dialog confirm with (`notifications`), the report dialog
  // (`reports`), and messages between matches, which are the shared identity layer's (`social`).
  // No `storage`: nothing is remembered on the phone.
  permissions: ['app-events', 'media', 'notifications', 'reports', 'social'],
  requiresNetwork: true,
  /**
   * This app's unread persistent notifications — a message from a match — and nothing added to
   * them, for Glimpse's reason: every push that notifies already wrote a row. `lazyBadge`
   * because a manifest is evaluated while the SDK barrel is still initializing.
   */
  badgeStore: lazyBadge(async () => {
    const { useNotifications } = await import('@mica/sdk');
    return useNotifications('spark').unreadCount;
  }),
  // Required alongside a badgeStore (`sdk/appContract.test.ts`).
  preload: () => import('./store').then((m) => m.loadProfile())
});
