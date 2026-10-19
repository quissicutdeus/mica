// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@mica/sdk/app';

export default defineApp({
  id: 'casino',
  // A dark tile, so no `fg`: the glyph's near-white default reads on it (MICA-88).
  tile: { bg: 'bg-emerald-950' },
  icon: Icon,
  description: 'European roulette and Crash, staked from your bank account',
  author: 'micaOS',
  // An add-on (MICA-82): absent from the launcher until installed from the Store, and run in
  // the sandboxed frame. Phone-only — no `devices`, because there is no tablet layout.
  core: false,
  // What the scan finds: the server's `crash` push that ends a round (`app-events`). The
  // refusal toasts go through `useAppAction`, which needs no permission.
  permissions: ['app-events'],
  // Every stake is a debit and every win a credit, so a server with no framework behind it
  // cannot honour a single action in this app — Hodlr's reason.
  requires: ['money']
});
