// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get, writable } from 'svelte/store';
import type { DeviceId } from '@mica/shared/devices';
import { fetchNui } from '../../nui/fetchNui';
import { activeDevice } from './device';
import { appRegistryStore } from './registry';
import { manifestSupportsDevice } from '../../lib/phone/appVisibility';
import { disabledAppIds } from './ownerConfig';
import { openDevice } from './phoneOpen';

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

/**
 * MICA-356: which resident apps have a component tree in the frame that is up.
 *
 * Residency outlives a close, but the component trees do not: `Shell.svelte`'s
 * `{#if visible}` tears the frame down on every close (MICA-86 depends on that), so every
 * open rebuilds every resident app — its tree, its `HostProvider`, its subscriptions, and
 * each add-on's sandboxed iframe. Doing all of that at once landed on the very frames the
 * fly-in plays, for apps that are not even on screen.
 *
 * So an open mounts the current app at once and the rest of `runningApps` once the intro
 * is over (`RESIDENT_MOUNT_DELAY_MS`). The rest still has to mount: a resident app is a
 * running app, and what it registers from inside its component — a search provider, a
 * Control Center tile, an unscoped keybind, its `useAppLevels` ladder — is only there while
 * it is mounted. `useSearchProvider` promises an app opened once stays findable. Anything
 * that shows those registrations before the delay is up calls `mountResidentApps` to skip
 * the wait (`Shell.svelte`: the drawer, its search, the Control Center).
 *
 * Reset on close and on a device swap, the two ways a frame is created afresh. Driven by
 * `openDevice`, `Shell`'s own mirror of its `visible` rune, rather than a call `Shell` has
 * to remember to make. That mirror is set by an effect, *after* the open's first render —
 * which is why `Shell` mounts the current app on `isActive` as well as on this set, and
 * why the set it renders against on an open is the empty one the close left.
 *
 * An id is never removed while the frame is up: an evicted or closed app is no longer in
 * `runningApps`, so a stale id here renders nothing, and the only way back into the list
 * is `openApp`, which makes it current anyway.
 */
let mountedSet: ReadonlySet<string> = new Set();
const mounted = writable<ReadonlySet<string>>(mountedSet);
export const mountedApps = { subscribe: mounted.subscribe };

/**
 * How long after an open the background resident apps mount: the frame's fly-in, which is
 * `duration: 500` on both `PhoneFrame.svelte` and `TabletFrame.svelte`.
 *
 * A timer at the intro's own length rather than `requestIdleCallback`. The fly is a Web
 * Animation, so the main thread sits idle for most of it and an idle callback would fire
 * mid-intro — the window this exists to keep clear. A `timeout` on one only bounds the
 * wait from above, never from below. Change it with the frames' duration.
 */
export const RESIDENT_MOUNT_DELAY_MS = 500;

/** The device whose frame `mountedSet` describes, or `null` while no frame is up. */
let mountedOn: DeviceId | null = null;
let residentTimer: ReturnType<typeof setTimeout> | null = null;

const clearResidentTimer = () => {
  if (residentTimer === null) return;
  clearTimeout(residentTimer);
  residentTimer = null;
};

const resetMounted = (ids: readonly string[]) => {
  mountedSet = new Set(ids.filter((id) => id !== 'home'));
  mounted.set(mountedSet);
};

/**
 * Mount every resident app in the frame that is up, now rather than when the intro ends.
 * A no-op while no frame is up — there is nothing to mount into — and once they all are.
 */
export const mountResidentApps = () => {
  if (mountedOn === null) return;
  clearResidentTimer();
  const missing = get(runningApps).filter((a) => !mountedSet.has(a.id));
  if (missing.length === 0) return;
  mountedSet = new Set([...mountedSet, ...missing.map((a) => a.id)]);
  mounted.set(mountedSet);
};

openDevice.subscribe((frame) => {
  if (frame === mountedOn) return;
  mountedOn = frame;
  clearResidentTimer();
  resetMounted(frame === null ? [] : [get(currentApp).id]);
  if (frame !== null) residentTimer = setTimeout(mountResidentApps, RESIDENT_MOUNT_DELAY_MS);
});

currentApp.subscribe(({ id }) => {
  if (mountedOn === null || id === 'home' || mountedSet.has(id)) return;
  mountedSet = new Set([...mountedSet, id]);
  mounted.set(mountedSet);
});

activeDevice.subscribe((next) => {
  if (next === device) return;
  snapshots.set(device, { running: get(runningApps), current: get(currentApp), recency });
  const restored = snapshots.get(next);
  device = next;
  // The other device's frame is about to be built with none of its apps mounted. Before
  // `currentApp` moves, so the restored app is the one noted into the fresh set.
  resetMounted([]);
  recency = restored?.recency ?? [];
  runningApps.set(restored?.running ?? []);
  currentApp.set(restored?.current ?? { id: 'home', props: {} });
});

/**
 * Drop a disabled id out of one device's navigation state — a plain filter, not a call to
 * `closeApp`: `closeApp` only ever reaches the *active* device's live stores, and a device
 * the player is not holding has its own state sitting in `snapshots` instead.
 */
const withoutDisabled = (snapshot: NavSnapshot, $disabled: ReadonlySet<string>): NavSnapshot => ({
  running: snapshot.running.filter((a) => !$disabled.has(a.id)),
  current: $disabled.has(snapshot.current.id) ? { id: 'home', props: {} } : snapshot.current,
  recency: snapshot.recency.filter((r) => !$disabled.has(r))
});

/**
 * MICA-234: close an app the owner just disabled, wherever it is resident.
 *
 * `isKnownApp` already refuses to *open* a disabled id, but a deep link, a notification
 * tap, or the client's own `openApp` can all run before `shell:ownerConfig` has answered
 * (`refreshOwnerConfig` is one of several `Promise.allSettled` entries in `bootstrapStores`,
 * with nothing that makes it win the race) — that is `devHarness.ts`'s `openDeepLinkedApp`,
 * called from `Shell.svelte`'s `onMount`, strictly before the `$effect` that calls
 * `bootstrapStores`. So the guard alone is not enough: an app already open when the answer
 * lands, or a live config change from an admin command, has to be torn down too.
 *
 * Deliberately a plain filter recomputed on every `disabledAppIds` change rather than a
 * one-shot reaction to newly-added ids: an id that is disabled and later re-enabled is not
 * running any more by the time it comes back (this same subscription already closed it), so
 * there is nothing to reopen either way, and recomputing needs no memory of the previous set.
 * The empty-set short-circuit below is what keeps this a no-op for every ordinary session,
 * where nothing is ever disabled.
 */
disabledAppIds.subscribe(($disabled) => {
  if ($disabled.size === 0) return;

  const activeNext = withoutDisabled(
    { running: get(runningApps), current: get(currentApp), recency },
    $disabled
  );
  recency = activeNext.recency;
  runningApps.set(activeNext.running);
  currentApp.set(activeNext.current);

  for (const [id, snapshot] of snapshots) {
    snapshots.set(id, withoutDisabled(snapshot, $disabled));
  }
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
  resetMounted([]);
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
