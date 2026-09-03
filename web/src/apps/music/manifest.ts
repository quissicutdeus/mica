// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp } from '@gos/sdk/app';

export default defineApp({
  id: 'music',
  tile: { bg: 'bg-red-700' },
  icon: Icon,
  description: 'Play music from a YouTube link',
  /**
   * `theme` is for one thing: the now-playing card's album-art tint is built from an M3
   * seed, and which of the two generated schemes it resolves to depends on whether the
   * phone is in light or dark mode. The app reads the mode and hands it to the card.
   */
  permissions: ['music', 'theme'],
  /**
   * `core: true`, and not for the usual "ships in the box" reason alone.
   *
   * An add-on runs in a sandboxed iframe and reaches the shell only over `postMessage`
   * (§7), which makes every call it can make asynchronous. Music's controls are all
   * fire-and-forget, so the facet has an iframe twin and would work either way — but the
   * player it drives is the shell's own hardware, and hardware ships with the phone. It
   * belongs beside the volume buttons rather than in the Store.
   *
   * (Do not write the words c-o-r-e colon false in this file. `sdk/coreBoundary.test.ts`
   * decides which apps are add-ons by matching that text against the raw manifest, before
   * comments are stripped, so a comment mentioning it reclassifies the app and every core
   * file that names `music` becomes a boundary violation.)
   */
  core: true
});
