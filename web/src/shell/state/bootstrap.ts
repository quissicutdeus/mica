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
import { DEFAULT_DEVICE, type DeviceId } from '@mica/shared/devices';
import { manifestSupportsDevice } from '../../lib/phone/appVisibility';
import { currentApp } from './navigation';

let isBootstrapped = false;
let running = false;
/** Which run is current, so a superseded one cannot write the flags of the one that replaced it. */
let runId = 0;
let bootstrapPromise: Promise<void> | null = null;

/**
 * How long app preloads wait after an open: `PhoneFrame`'s fly-in, `duration: 500` (MICA-364).
 *
 * The first open used to start every app's `preload` in the same tick as the fly-in — about
 * seventeen NUI round trips and two chunk imports competing with the one animation the player
 * is watching. None of that is needed to paint the home screen; it is needed before an *app*
 * is shown, and `deferAppPreloads` starts it the moment one is, so waiting out the animation
 * costs nothing an app can see.
 */
const APP_PRELOAD_DELAY_MS = 500;

/** The deferred preloads of the run in progress, if they have not started yet. */
let pendingPreloads: { cancel: () => void } | null = null;

/** Every app this device shows and the owner has not disabled — read when the preloads run. */
const preloadsFor = (device: DeviceId) =>
  [...registeredApps, ...bundledAddOns]
    .filter((app) => !get(disabledAppIds).has(app.id))
    .filter((app) => manifestSupportsDevice(app, device))
    .map((app) => app.preload?.());

/**
 * Run the app preloads once the open animation has played, or at once if an app is shown first.
 *
 * **Every store is still loaded before its app is shown.** The trigger is `currentApp`
 * leaving home, which `openApp` sets synchronously, so the preloads start in the same tick the
 * app is asked for — before Svelte has rendered a frame of it — exactly as early as they did
 * when they started with the open. A phone opened straight onto an app (a notification tap, a
 * reopen with one still up) runs them immediately, for the same reason.
 *
 * Cancelled by `resetBootstrapState` and by a forced re-run: a device or character switch must
 * not have the previous identity's preloads land half a second later.
 */
function deferAppPreloads(device: DeviceId): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let stopWatching: (() => void) | undefined;

    const finish = (run: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopWatching?.();
      if (pendingPreloads === entry) pendingPreloads = null;
      if (!run) {
        resolve();
        return;
      }
      // MICA-234: the disabled list is read here rather than when the open began, so it is
      // whatever `refreshOwnerConfig` — usually answered by now — last said.
      let preloads: unknown[] = [];
      try {
        preloads = preloadsFor(device);
      } catch (error) {
        console.error('Failed to start app preloads:', error);
      }
      void Promise.allSettled(preloads).then(() => resolve());
    };

    const entry = { cancel: () => finish(false) };
    pendingPreloads = entry;
    const timer = setTimeout(() => finish(true), APP_PRELOAD_DELAY_MS);
    // Called once at once with the current value, so an app already up runs them now.
    const unsubscribe = currentApp.subscribe(($app) => {
      if ($app.id !== 'home') finish(true);
    });
    if (settled) unsubscribe();
    else stopWatching = unsubscribe;
  });
}

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
  // A run still in flight is shared too, not only a finished one: with the preloads deferred,
  // a close and reopen inside the window would otherwise start a second full run.
  if ((isBootstrapped || running) && !force && bootstrapPromise) {
    return bootstrapPromise;
  }

  // A forced run supersedes the last one's preloads if they have not started.
  pendingPreloads?.cancel();
  const run = ++runId;
  running = true;
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
        //
        // MICA-364: only on a forced run. An unforced one is the open itself (`Shell.svelte`'s
        // `visible` effect is its only caller), and that open mounts `PhoneFrame` and the
        // `NotificationShade` inside it, whose own mount reads these counts — so asking here too
        // was the same request twice in the fly-in. A forced run is a character or device switch
        // with the frame possibly already up, where nothing remounts, so it still asks.
        ...(onPhone && force ? [loadUnreadCounts()] : []),
        // App preloads, after the open animation (MICA-364): `deferAppPreloads` has when and
        // why, and `preloadsFor` which apps.
        //
        // MICA-234: a preload the owner has already told us is disabled is skipped — its data
        // is refused server-side regardless (§2.9), so calling for it is only ever wasted work
        // and a refusal to log. Read with `get`, not awaited: this is a courtesy that cuts
        // noise, not a security boundary, the same as `openApp` (`navigation.ts`) never gates
        // *opening* on it, so it must not cost every boot the round trip.
        //
        // MICA-264: and one the active device does not show. A tablet is an identity of its
        // own, and the server refuses a request from it to a service that is the phone's alone
        // (contacts, the call log, the bank) — so preloading those from the tablet was a
        // refusal per app on every boot, for a list it can never open. A device switch resets
        // the bootstrap and runs it again for the new device (`state/deviceIdentity.ts`).
        deferAppPreloads(device)
      ]);
      if (run === runId) isBootstrapped = true;
    } catch (error) {
      console.error('Failed during store bootstrapping:', error);
    } finally {
      if (run === runId) running = false;
    }
  })();

  return bootstrapPromise;
}

export function resetBootstrapState(): void {
  pendingPreloads?.cancel();
  runId += 1;
  isBootstrapped = false;
  running = false;
  bootstrapPromise = null;
}
