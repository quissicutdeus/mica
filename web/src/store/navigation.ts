import { get, writable } from 'svelte/store';
import { fetchNui } from '../utils/fetchNui';

/**
 * Which app is on screen, and which apps are still alive behind it.
 *
 * Apps used to be mounted one at a time under a `{#key currentApp.name}` block, so
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

export interface AppInstance {
  name: string;
  props: Record<string, any>;
}

/**
 * How many apps stay resident. Beyond this the least recently used is unmounted.
 *
 * Unbounded residency is a slow leak: every app ever opened would keep its component
 * tree, subscriptions and timers alive for the whole session. A cap makes the cost
 * knowable, and matches what a phone does when memory runs short.
 */
export const MAX_RESIDENT_APPS = 5;

/** Resident apps, least recently active first. */
export const runningApps = writable<AppInstance[]>([]);

/** Whatever is on screen. `home` is the shell, not an app, and is never resident. */
export const currentApp = writable<AppInstance>({ name: 'home', props: {} });

export const openApp = (appName: string, props: any = {}) => {
  const name = appName.toLowerCase();

  if (name === 'home') {
    goHome();
    return;
  }

  let resolved: AppInstance = { name, props };

  runningApps.update((apps) => {
    const existing = apps.find((a) => a.name === name);

    // Merged, not replaced: a plain launch passes `{}` and must not wipe the props a
    // deep link set earlier. A deep link passes its own keys and those win.
    resolved = { name, props: { ...(existing?.props ?? {}), ...props } };

    // Re-append so array order is recency order, then evict from the front.
    return [...apps.filter((a) => a.name !== name), resolved].slice(-MAX_RESIDENT_APPS);
  });

  currentApp.set(resolved);
};

export const goHome = () => {
  currentApp.set({ name: 'home', props: {} });
};

/**
 * Unmount an app, discarding its state.
 *
 * The deliberate counterpart to residency: without it there is no way to get a
 * genuinely fresh start short of reloading the UI.
 */
export const closeApp = (appName: string) => {
  const name = appName.toLowerCase();
  runningApps.update((apps) => apps.filter((a) => a.name !== name));
  if (get(currentApp).name === name) goHome();
};

export const closeAllApps = () => {
  runningApps.set([]);
  goHome();
};

export const closePhone = () => {
  fetchNui('hideFrame');
  // Apps stay resident across an open/close cycle, the same as pocketing a phone.
  goHome();
};
