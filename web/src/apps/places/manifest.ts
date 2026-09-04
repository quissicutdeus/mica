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
  description: 'Recently shared locations, saved places, and a waypoint in one tap.',
  // `useLocation` (share-my-position / set-waypoint) and `useMedia` (reading the
  // recently-shared-locations list, which is `kind: 'location'` rows in the media
  // service) — see `permissions.ts`'s `PERMISSION_OF` table.
  permissions: ['location', 'media'],
  author: 'micaOS',
  // MICA-65: ships in the box, scoped to the "Places" reading of the ticket — recent
  // shared locations, share/waypoint actions, and saved places. No map canvas (deferred),
  // no live location sharing window (deferred), no job-resource exports (deferred).
  core: true
});
