// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get, writable } from 'svelte/store';
import type { DeviceId } from '@mica/shared/devices';
import { fetchNui } from '../../nui/fetchNui';
import { activeDevice } from './device';
import { appRegistryStore } from './registry';
import { manifestSupportsDevice } from '../../lib/phone/appVisibility';

/**
 * Which app is on screen, and which apps are still alive behind it.
 *
 * Apps used to be mounted one at a time under a `{#key currentApp.id}` block, so
 * navigating away destroyed the component and everything in it — scroll position, a
 * half-typed message, an expanded section. That is structural rather than a bug in any
 * one app, and every app inherits it. It has already forced two workarounds: the
 * DevTools unlock had to be written to storage to survive a trip to another app, and
 * Settings' sub-panes are local state specifically to avoid crossing this boundary.
 *
 * Now an opened app stays mounted and is merely hidden, the way a phone keeps apps
 * resident. State preservation is then total and automatic — including DOM state such
 * as scroll offset, which no save/restore API could reasonably capture.
 */

import type { RunningApp } from '@mica/sdk';

/**
 * How many apps stay resident. Beyond this the least recently used is unmounted.
 *
 * Unbounded residency is a slow leak: every app ever opened would keep its component
 * tree, subscriptions and timers alive for the whole session. A cap makes the cost
 * knowable, and matches what a phone does when memory runs short.
 */
export const MAX_RESIDENT_APPS = 5;

/** Resident apps, least recently active first. */
export const runningApps = writable<RunningApp[]>([]);

/**
 * Which resident app was used least recently, most-recent last.
 *
 * Deliberately not `runningApps`' own order — see the note in `openApp`. Eviction needs
 * recency; the DOM needs stability; these are two different orders and conflating them is
 * what made add-ons blank out.
 */
let recency: string[] = [];

/** Whatever is on screen. `home` is the shell, not an app, and is never resident. */
export const currentApp = writable<RunningApp>({ id: 'home', props: {} });

/**
 * Each device keeps its own navigation (MICA-259).
 *
 * The three pieces above are the *active* device's. When `activeDevice` moves, they are
 * stashed under the device being left and the other device's are put back — or fresh ones
 * if it has never been opened — so a tablet set down on its Notes editor is still on it
 * when the phone has been used in between, and the phone's resident apps are not the
 * tablet's.
 *
 * Only ids and props are stored, never components. The frame already unmounts on close
 * (`Shell.svelte`'s `{#if visible}`), so two resident DOM trees never coexist; a swap is
 * a close and an open in one tick, and what an app kept in its own DOM — scroll offset,
 * a half-typed field — is lost across a device swap the way it is across a character
 * switch. That is also what keeps Chromium 103's hidden-frame relayout problem out of
 * this design entirely: there is never a hidden frame.
 */
interface NavSnapshot {
  running: RunningApp[];
  current: RunningApp;
  recency: string[];
}

const snapshots = new Map<DeviceId, NavSnapshot>();
let device: DeviceId = get(activeDevice);

activeDevice.subscribe((next) => {
  if (next === device) return;
  snapshots.set(device, { running: get(runningApps), current: get(currentApp), recency });
  const restored = snapshots.get(next);
  device = next;
  recency = restored?.recency ?? [];
  runningApps.set(restored?.running ?? []);
  currentApp.set(restored?.current ?? { id: 'home', props: {} });
});

export const openApp = (appName: string, props: Record<string, unknown> = {}) => {
  const id = appName.toLowerCase();

  if (id === 'home') {
    goHome();
    return;
  }

  /**
   * An id nothing can render is refused here rather than downstream.
   *
   * `Shell.svelte` renders `{#if AppComponent}` and skips `<Home>` whenever `currentApp`
   * is not home — so an unresolvable id produced a blank screen with no back affordance,
   * and it stayed that way because CEF never reloads the page. A notification deep link
   * did this on every tap for months. The guard belongs at the entry point: every caller
   * would otherwise need its own check, and the one that forgot is the one that shipped.
   */
  /**
   * Does the app exist — not "has its code arrived".
   *
   * Those were the same question while every component loaded at boot. Components are
   * lazy now, so asking whether one is loaded would refuse an app the first time it is
   * ever opened and let it through the second.
   */
  if (!appRegistryStore.isKnownApp(id)) {
    console.warn(`[navigation] Refusing to open '${id}': no app by that id is installed.`);
    return;
  }

  /**
   * And does it run on the device that is up (MICA-260). The launcher, dock, drawer,
   * folders and search already hide it; this is the deep link, the notification tap and
   * the client's `openApp`, which would otherwise put a phone-only root inside the tablet
   * frame. A manifest the registry cannot resolve yet is let through, as the guard above
   * lets a chunk still in flight through.
   */
  const device = get(activeDevice);
  const manifest = appRegistryStore.getManifest(id);
  if (manifest && !manifestSupportsDevice(manifest, device)) {
    console.warn(`[navigation] Refusing to open '${id}': it does not run on the ${device}.`);
    return;
  }

  let resolved: RunningApp = { id, props };

  runningApps.update((apps) => {
    const existing = apps.find((a) => a.id === id);

    // Merged, not replaced: a plain launch passes `{}` and must not wipe the props a
    // deep link set earlier. A deep link passes its own keys and those win.
    resolved = { id, props: { ...existing?.props, ...props } };

    // Recency is tracked beside the list, never *as* its order.
    //
    // This array is the order `Shell` renders in, so it is the DOM's order, and a keyed
    // `{#each}` physically moves a node when its position changes. Moving an iframe
    // reloads it — a new browsing context, a new `contentWindow` — and `AddOnFrame`'s
    // host server has already captured the old one as the window it will accept messages
    // from. The reloaded add-on announced itself, was refused as a stranger, and sat
    // there blank forever. Re-appending on every open meant that happened to any resident
    // add-on as soon as you opened something else and came back to it.
    //
    // So a mounted app keeps its slot for as long as it lives, and only its props change.
    recency = [...recency.filter((r) => r !== id), id];

    const next = existing ? apps.map((a) => (a.id === id ? resolved : a)) : [...apps, resolved];
    if (next.length <= MAX_RESIDENT_APPS) return next;

    // Evict the least recently active, never what was just opened. Dropping entries does
    // not disturb the relative order of the ones that stay, so no surviving node moves.
    const evicted = new Set(
      recency.filter((r) => r !== id).slice(0, next.length - MAX_RESIDENT_APPS)
    );
    recency = recency.filter((r) => !evicted.has(r));
    return next.filter((a) => !evicted.has(a.id));
  });

  currentApp.set(resolved);

  /**
   * Pull the chunk in, and nudge the list when it lands.
   *
   * `runningApps` is what `Shell` renders from, and `getComponent` is a plain call rather
   * than a store — so without re-setting the array the app would sit on its loading
   * placeholder until some other state happened to change. Idempotent: `loadComponent`
   * caches both the module and the in-flight promise.
   */
  void appRegistryStore
    .loadComponent(id, device)
    .then(() => runningApps.update((apps) => [...apps]));
};

/**
 * Clear an app's deep-link props once it has acted on them.
 *
 * Deep links became sticky the moment apps started staying resident: the props that
 * opened Photos on a specific picture are still set when you press back, so the
 * "open this one" effect fires again and the back button appears dead. Under the old
 * mount-per-navigation model the props died with the component and the problem could
 * not arise.
 *
 * One-shot is the right semantic regardless: `openApp('media', { initialPhoto })` is
 * an instruction to do something once, not a description of lasting state.
 */
export const consumeAppProps = (appName: string) => {
  const id = appName.toLowerCase();
  runningApps.update((apps) => apps.map((a) => (a.id === id ? { id, props: {} } : a)));
  currentApp.update((c) => (c.id === id ? { id, props: {} } : c));
};

export const goHome = () => {
  currentApp.set({ id: 'home', props: {} });
};

/**
 * Unmount an app, discarding its state.
 *
 * The deliberate counterpart to residency: without it there is no way to get a
 * genuinely fresh start short of reloading the UI.
 */
export const closeApp = (appName: string) => {
  const id = appName.toLowerCase();
  recency = recency.filter((r) => r !== id);
  runningApps.update((apps) => apps.filter((a) => a.id !== id));
  if (get(currentApp).id === id) goHome();
};

/** Every device's, not just the active one — a character switch owns no tablet either. */
export const closeAllApps = () => {
  snapshots.clear();
  recency = [];
  runningApps.set([]);
  goHome();
};

export const closePhone = () => {
  fetchNui('hideFrame');
  // Deliberately does *not* go home. Two reasons, both visible in game:
  //
  // Switching to home before the frame hides meant you watched the phone navigate away
  // from whatever you were looking at on its way out.
  //
  // And a phone you put away and take out again should still be on the screen you left
  // it on. Apps are already resident; going home threw away the one piece of state that
  // made that observable.
};
