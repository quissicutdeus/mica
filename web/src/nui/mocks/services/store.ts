// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { StoreCatalogResult } from '@mica/shared/contracts/store';
import type { MockHandler } from '../registry';

export const mocks: Record<string, MockHandler> = {
  /**
   * The add-on catalog the server would fetch on the phones' behalf (MICA-237).
   *
   * A browser has no server and no convars, so the browser plays the server: it fetches the
   * catalog itself, from `VITE_MICA_ADDON_CATALOG` — the stand-in for `mica_addon_catalog`
   * that `remoteAppConfig` (`services/client.ts`) already reads — and answers the way the
   * server does. `ok` carries the array unvalidated, since validating it is the shell's
   * job; `unavailable` is a failed fetch or a body that is not an array; `off` is the
   * variable unset, empty or `off`. **Unset is `off` here, not the public catalog a stock
   * server points at**: a mock that reached out to a real host would make every ordinary
   * `pnpm dev` and Playwright run
   * depend on the network, and would be the one place a Store lists remote apps nobody
   * configured. The demo image sets the variable, so it lists and installs from its own
   * catalog exactly as before.
   *
   * `?mica_addon_catalog=<url>` overrides the variable for one page load, which is how a
   * spec drives the three answers without a rebuild.
   */
  'store:catalog': async (): Promise<StoreCatalogResult> => {
    const fromQuery =
      typeof window === 'undefined'
        ? null
        : new URLSearchParams(window.location.search).get('mica_addon_catalog');
    const url = (fromQuery ?? String(import.meta.env.VITE_MICA_ADDON_CATALOG ?? '')).trim();
    if (!url || url.toLowerCase() === 'off') return { status: 'off' };
    try {
      const response = await fetch(url);
      if (!response.ok) return { status: 'unavailable' };
      const body: unknown = await response.json();
      return Array.isArray(body) ? { status: 'ok', entries: body } : { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    }
  }
};
