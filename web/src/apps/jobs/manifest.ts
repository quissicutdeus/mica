// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@mica/sdk/app';

export default defineApp({
  id: 'jobs',
  // A light tile, so the glyph states its own colour (MICA-88).
  tile: { bg: 'bg-amber-600', fg: 'text-gray-900' },
  icon: Icon,
  description: 'See every job you hold, switch the active one and toggle duty',
  // 'jobs': the list, the switch and the duty toggle, via `useJobs`.
  // 'call': the number a job's lines register, dialled from the card.
  // 'app-events': the server's `changed` push, so a switch made elsewhere shows here.
  // 'app-events' also carries `line_message`, a job line's inbox changing (MICA-307).
  // 'notifications': the toast a refused switch or duty change explains itself with.
  // 'contacts': a caller's saved name in a job line's inbox, as Messages shows it.
  permissions: ['jobs', 'call', 'app-events', 'notifications', 'contacts'],
  // Every job here comes from the framework bridge, which is simply absent in standalone
  // mode. Distinct from the `jobs` permission above: that discloses what this app reaches
  // for, this states what the server has to be able to do.
  requires: ['jobs'],
  requiresNetwork: true,
  core: true
});
