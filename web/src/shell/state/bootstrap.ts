// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get } from 'svelte/store';
import { fetchCitizenId, fetchBalance } from '../../services/account';
import { refreshAdmin } from '../../services/admin';
import { refreshCapabilities } from '../../services/capabilities';
import { refreshImageHost } from '../../services/imageHost';
import { refreshLocale, refreshServerLanguages } from './locale';
import { disabledAppIds, refreshOwnerConfig } from './ownerConfig';
import { loadUnreadCounts } from '../../services/notifications';
import { bundledAddOns, registeredApps } from './registry';
import { activeDevice } from './device';
import { DEFAULT_DEVICE } from '@mica/shared/devices';
import { manifestSupportsDevice } from '../../lib/phone/appVisibility';

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
    // MICA-264: the device this run loads for, read once. A device switch resets the
    // bootstrap and runs it again for the new one (`state/deviceIdentity.ts`), so a run never
    // has to follow a change part-way through.
    const device = get(activeDevice);
    // The phone's own reads. The server answers a tablet only for the services it lists —
    // shell, settings, notes, lockscreen, store, admin and mail — and refuses the rest, so a
    // read for anything else is skipped on any other device rather than sent to be refused.
    const onPhone = device === DEFAULT_DEVICE;
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
        // MICA-235: languages an owner dropped on disk, and (via the store) their strings.
        refreshServerLanguages(),
        // MICA-234: which apps the owner disabled, and the default dock, before the
        // launcher and dock draw a slot they should be hiding or filling.
        refreshOwnerConfig(),
        // MICA-243: where hosted photos live, before an add-on frame is built with a CSP
        // that has to let them in.
        refreshImageHost(),
        // The framework's citizen id, read by the client itself (`client/client.ts`): no
        // service behind it, and the citizen is the same on either device.
        fetchCitizenId(),
        // The Bank's balance, and the Bank is a phone app with no tablet layout.
        ...(onPhone ? [fetchBalance()] : []),
        // The launcher badges' unread counts, from the `notifications` service, which is the
        // phone's alone: the tablet's badges stay empty until it has a service to ask.
        ...(onPhone ? [loadUnreadCounts()] : []),
        // MICA-234: skip a preload the owner has already told us is disabled — its data is
        // refused server-side regardless (§2.9), so calling for it here is only ever wasted
        // work and a refusal to log. Read with `get`, not awaited: `refreshOwnerConfig()` is
        // one of this same array's entries and has not necessarily answered yet, so this is
        // whatever the *last* bootstrap already knew — nothing, on a player's very first
        // boot, and the real list from then on, since a character switch re-runs this whole
        // function. Not gated on the answer landing first, deliberately, the same as
        // `openApp` (`navigation.ts`) never gates *opening* on it: this is a courtesy that
        // cuts noise, not a security boundary, so it must not cost every boot the round trip.
        //
        // MICA-264: and skip one the active device does not show. A tablet is an identity of
        // its own, and the server refuses a request from it to a service that is the phone's
        // alone (contacts, the call log, the bank) — so preloading those from the tablet was
        // a refusal per app on every boot, for a list it can never open. Read when the
        // bootstrap runs: a device switch resets it and runs it again for the new device
        // (`state/deviceIdentity.ts`).
        ...[...registeredApps, ...bundledAddOns]
          .filter((app) => !get(disabledAppIds).has(app.id))
          .filter((app) => manifestSupportsDevice(app, device))
          .map((app) => app.preload?.())
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
