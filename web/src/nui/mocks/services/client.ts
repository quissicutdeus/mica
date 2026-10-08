// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MockHandler } from '../registry';

export const mocks: Record<string, MockHandler> = {
  // Account
  getCitizenId: () => 'my-id',
  getPhoneNumber: () => '867-5309',
  /**
   * `mica_addon_hosts` and `mica_addon_catalog` (MICA-126).
   *
   * **Empty by default, because a stock server is.** A mock that helpfully returned a
   * catalog would make the dev browser the one place remote installs work, which is
   * precisely the divergence mocks are supposed not to introduce.
   *
   * The two env vars are the browser harness's stand-in for the convars, so the loop an
   * operator configures in `server.cfg` can be walked end to end without a game running:
   *
   * ```sh
   * VITE_MICA_ADDON_HOSTS=store.example.com \
   * VITE_MICA_ADDON_CATALOG=https://store.example.com/catalog.json pnpm dev
   * ```
   *
   * Unset — which is every ordinary `pnpm dev`, every Playwright run and every production
   * build — they resolve to exactly what an unconfigured client answers.
   */
  remoteAppConfig: async () => ({
    hosts: String(import.meta.env.VITE_MICA_ADDON_HOSTS ?? '')
      .split(/[\s,]+/)
      .filter(Boolean),
    catalogUrl: String(import.meta.env.VITE_MICA_ADDON_CATALOG ?? '')
  }),

  // Navigation & Client Controls
  hideFrame: () => true,
  toggleFreelook: () => true,
  setTyping: () => true,
  setBatteryLevel: () => true
};
