// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@mica/sdk/app';

export default defineApp({
  id: 'places',
  // The launcher tile.
  tile: { bg: 'bg-emerald-600', fg: 'text-white' },
  icon: Icon,
  description: 'A map of your saved places and friends, live location sharing, and waypoints.',
  // `useLocation` (share-my-position / set-waypoint), `useMedia` (reading the
  // recently-shared-locations list, which is `kind: 'location'` rows in the media
  // service) and `useContacts` (choosing who sees a live share, and naming a friend's pin)
  // — see `permissions.ts`'s `PERMISSION_OF` table. Polling only while Places is on screen
  // is `useAppVisible` since MICA-294, which is implicit, so `navigation` went with it.
  permissions: ['location', 'media', 'contacts'],
  author: 'micaOS',
  // MICA-65: recent shared locations, share/waypoint actions, and saved places. MICA-244:
  // the map canvas and live location sharing. No job-resource exports (deferred).
  core: true
});
