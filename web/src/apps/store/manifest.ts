// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Icon from './Icon.svelte';
import { defineApp, lazyBadge } from '@mica/sdk/app';

export default defineApp({
  id: 'store',
  tile: { bg: 'bg-indigo-600' },
  icon: Icon,
  author: 'micaOS',
  description: 'Browse, install, and manage micaOS community apps and permissions',
  permissions: ['app-registry', 'app-registry-write', 'navigation', 'storage'],
  requiresNetwork: true,
  core: true,
  /**
   * Installed add-ons the catalog has moved past (MICA-74).
   *
   * On the launcher because that is the only place a player looks without being told to.
   * The Store already knew both numbers — the version it installed and the version the
   * catalog offers — and compared them nowhere, so the only way to find out a fix had
   * shipped was to uninstall and reinstall on a hunch.
   *
   * `lazyBadge` because a manifest is evaluated while the SDK barrel is still initializing;
   * calling `useAppRegistry()` out here throws.
   */
  badgeStore: lazyBadge(async () => {
    const { useAppRegistry } = await import('@mica/sdk');
    return useAppRegistry().updateCount;
  }),
  /**
   * Required alongside a badgeStore (`sdk/appContract.test.ts`), and the substance of the
   * feature rather than a formality: the count has to be right *before* the launcher paints,
   * and a check that only ran once the Store was open would only ever tell people who had
   * already gone looking. A no-op with no catalog configured.
   */
  preload: async () => {
    const { useAppRegistryWrite } = await import('@mica/sdk');
    await useAppRegistryWrite().refreshUpdates();
  }
});
