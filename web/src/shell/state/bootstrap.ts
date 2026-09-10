// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fetchCitizenId, fetchBalance } from '../../services/account';
import { refreshAdmin } from '../../services/admin';
import { refreshCapabilities } from '../../services/capabilities';
import { refreshLocale } from './locale';
import { refreshOwnerConfig } from './ownerConfig';
import { loadUnreadCounts } from '../../services/notifications';
import { bundledAddOns, registeredApps } from './registry';

let isBootstrapped = false;
let bootstrapPromise: Promise<void> | null = null;

/**
 * Preloads primary stores in parallel on phone opening, so switching between apps is
 * instant rather than a fetch away.
 *
 * The app-specific half is no longer listed here. It was a hardcoded set of store loads
 * with nothing connecting it to the apps it loaded for, so an app that shipped a
 * `badgeStore` and was forgotten in this file showed a stale badge until somebody opened
 * it — by which point the badge has stopped mattering. Apps declare `preload` in their own
 * manifest now, and a new one is included by existing.
 *
 * Add-ons are preloaded too, installed or not: it is one query, and it means the badge is
 * already right if the player installs the app mid-session.
 *
 * What stays here is what belongs to the shell rather than to any app — the account, the
 * admin check that decides whether the Administration icon is drawn at all, and the unread
 * notification counts.
 *
 * Those counts are one query answering for every app at once, which is why they are shell work
 * rather than something each `preload` repeats. Nothing fetched them until the shade or an app's
 * own notifications screen was opened, so a launcher badge fed from them counted only what
 * arrived over the push channel while the phone happened to be running — the persisted rows the
 * notifications table exists for reached the badge nowhere. A badge has to be right before the
 * launcher paints (§11.1).
 */
export async function bootstrapStores(force: boolean = false): Promise<void> {
  if (isBootstrapped && !force && bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    try {
      await Promise.allSettled([
        // Asked here so the home screen knows whether to draw the Administration app
        // before it renders, rather than having it appear a beat later.
        refreshAdmin(),
        // Same reason as the admin check, and the same re-read on a character switch:
        // `rehydrateShell` runs this whole function again, and both of these decide which
        // icons exist. `Shell.svelte` also asks at mount so the answer is usually already
        // in hand by the time the phone is first opened; the two share one request.
        refreshCapabilities(),
        // MICA-61: the owner's default language, before the first screen renders.
        refreshLocale(),
        // MICA-234: which apps the owner disabled, and the default dock, before the
        // launcher and dock draw a slot they should be hiding or filling.
        refreshOwnerConfig(),
        fetchCitizenId(),
        fetchBalance(),
        loadUnreadCounts(),
        ...[...registeredApps, ...bundledAddOns].map((app) => app.preload?.())
      ]);
      isBootstrapped = true;
    } catch (error) {
      console.error('Failed during store bootstrapping:', error);
    }
  })();

  return bootstrapPromise;
}

export function resetBootstrapState(): void {
  isBootstrapped = false;
  bootstrapPromise = null;
}
