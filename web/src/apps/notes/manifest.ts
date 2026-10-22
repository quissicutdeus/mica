// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@mica/sdk/app';

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
  permissions: ['storage', 'display', 'search'],
  /**
   * MICA-261: Notes is usable in the wide frame, with a root of its own for it. It is
   * `core: false`, so the shell does not mount `tablet.svelte` itself as it would a core
   * app's; the add-on build hands it to `bootAddOn` as the tablet root (MICA-265), and the
   * frame mounts it instead of `index.svelte` while the tablet is on screen.
   *
   * `display` above is what pays for that: the frame learns its device from
   * `useDisplay().device`, and the add-on build's permission scan counts a `tablet.svelte`
   * as that read and refuses a manifest that does not declare it.
   */
  devices: ['phone', 'tablet'],
  // No `author`: it is written in this repo, so it inherits 'micaOS' from defineApp. It
  // claimed 'Community' back when that string was what kept it out of the launcher —
  // `core: false` does that now, and the author is free to be true.
  core: false
});
