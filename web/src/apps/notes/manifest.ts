// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

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
  permissions: ['storage'],
  // No `author`: it is written in this repo, so it inherits 'gPhone' from defineApp. It
  // claimed 'Community' back when that string was what kept it out of the launcher —
  // `core: false` does that now, and the author is free to be true.
  core: false
});
