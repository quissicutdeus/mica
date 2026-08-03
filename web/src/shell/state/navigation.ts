import { get, writable } from 'svelte/store';
import { fetchNui } from '../../nui/fetchNui';

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

export interface RunningApp {
  /**
   * The app's registry id — `notes`, `settings`. Not its display name.
   *
   * It was called `name`, which read as the human-facing one and got used that way:
   * `ErrorBoundary` printed it, so a crash in Admin said "The admin app encountered a
   * problem". The manifest holds the display name; this is the key you look it up with.
   */
  id: string;
  props: Record<string, unknown>;
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
export const runningApps = writable<RunningApp[]>([]);

/** Whatever is on screen. `home` is the shell, not an app, and is never resident. */
export const currentApp = writable<RunningApp>({ id: 'home', props: {} });

export const openApp = (appName: string, props: Record<string, unknown> = {}) => {
  const id = appName.toLowerCase();

  if (id === 'home') {
    goHome();
    return;
  }

  let resolved: RunningApp = { id, props };

  runningApps.update((apps) => {
    const existing = apps.find((a) => a.id === id);

    // Merged, not replaced: a plain launch passes `{}` and must not wipe the props a
    // deep link set earlier. A deep link passes its own keys and those win.
    resolved = { id, props: { ...(existing?.props ?? {}), ...props } };

    // Re-append so array order is recency order, then evict from the front.
    return [...apps.filter((a) => a.id !== id), resolved].slice(-MAX_RESIDENT_APPS);
  });

  currentApp.set(resolved);
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
 * One-shot is the right semantic regardless: `openApp('photos', { initialPhoto })` is
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
  runningApps.update((apps) => apps.filter((a) => a.id !== id));
  if (get(currentApp).id === id) goHome();
};

export const closeAllApps = () => {
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
