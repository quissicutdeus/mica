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
  // service), `useContacts` (choosing who sees a live share, and naming a friend's pin)
  // and `useNavigation` (polling only while Places is on screen) — see `permissions.ts`'s
  // `PERMISSION_OF` table.
  permissions: ['location', 'media', 'contacts', 'navigation'],
  author: 'micaOS',
  // MICA-65: recent shared locations, share/waypoint actions, and saved places. MICA-244:
  // the map canvas and live location sharing. No job-resource exports (deferred).
  core: true
});
