// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@gos/sdk/app';

export default defineApp({
  id: 'notes',
  tile: { bg: 'bg-yellow-400', fg: 'text-gray-900' },
  icon: Icon,
  /**
   * Imported lazily, not at module scope.
   *
   * The registry globs every manifest eagerly, so a manifest that imports the store pulls
   * the SDK barrel in while that barrel is still initialising — and `byNewest` comes back
   * undefined. Same trap `lazyBadge` exists for. Deferring to the call keeps the manifest
   * a description rather than a thing with a dependency graph.
   */
  preload: () => import('./store').then((m) => m.notes.load()),
  description: 'Create and store personal notes',
  permissions: ['storage', 'display'],
  /**
   * MICA-261: Notes is usable in the wide frame. It is `core: false`, so the shell
   * cannot mount a second root for it — the add-on bundle has one entry, `index.svelte`
   * (`web/vite.addon.config.ts`), and a separate tablet entry is MICA-265. So this is
   * the "one root, two layouts" path: `index.svelte` reads `useDisplay().device` and
   * renders `tablet.svelte` in the tablet frame. `tablet.svelte` is a real root all the
   * same, so the day the add-on build learns about it nothing here has to move.
   *
   * `display` above is what pays for that read — the add-on build's permission scan
   * refuses a manifest that understates what its code imports.
   */
  devices: ['phone', 'tablet'],
  // No `author`: it is written in this repo, so it inherits 'gOS' from defineApp. It
  // claimed 'Community' back when that string was what kept it out of the launcher —
  // `core: false` does that now, and the author is free to be true.
  core: false
});
