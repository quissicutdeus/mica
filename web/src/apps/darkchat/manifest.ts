// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@mica/sdk/app';

export default defineApp({
  id: 'darkchat',
  name: 'Dark Chat',
  // A dark tile, so no `fg`: the glyph's near-white default reads on it (MICA-88).
  tile: { bg: 'bg-gray-950' },
  icon: Icon,
  description: 'Invite-only channels under an alias, where messages do not last',
  author: 'micaOS',
  // An add-on (MICA-254): absent from the launcher until installed from the Store, and run in
  // the sandboxed frame. Phone-only — no `devices`, because there is no tablet layout.
  core: false,
  // What the scan finds and nothing more: the new-message push (`app-events`), and the report
  // dialog, which files the report (`reports`) and confirms it with a toast (`notifications`).
  // No `storage`, because nothing is remembered on the phone, and no `social`, because an
  // alias is the channel's and not an account.
  permissions: ['app-events', 'notifications', 'reports'],
  requiresNetwork: true
});
