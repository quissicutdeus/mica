import { debugData } from '../lib/debug';
import { appRegistryStore } from './state/registry';
import { openApp } from './state/navigation';

/**
 * Browser-only scaffolding: seed the phone, and expose a console helper for firing
 * notifications by hand.
 *
 * Lived inline in `App.svelte` and was roughly eighty of its lines, none of which the
 * shell needs in order to work. It also drives everything through `window.postMessage`
 * — the same path the client uses — so it exercises the real router rather than a
 * parallel one, and belongs next to it.
 */

type TestToast = 'message' | 'contact' | 'call' | 'email';

const FIXTURES: Record<TestToast, { action: string; data: unknown }> = {
  message: {
    action: 'receiveMessage',
    data: {
      conversation_id: 1,
      senderName: 'Ursula (Crazy Ex)',
      message: '1... 🤬😡🗯️‼️',
      phone: '555-0199',
      avatar:
        'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=500&auto=format&fit=crop&q=80'
    }
  },
  contact: {
    action: 'shareContact',
    data: { firstname: 'Franklin', lastname: 'Clinton', phone: '555-0177' }
  },
  call: {
    action: 'callStatus',
    data: { status: 'incoming', name: 'Lester Crest', number: '555-0155' }
  },
  email: {
    action: 'receiveMail',
    data: { sender: 'Fleeca Bank', subject: 'Your Monthly Account Statement is Ready' }
  }
};

/**
 * Seed the phone so a browser session starts with something on screen.
 *
 * Immediately, not on `debugData`'s default 1000ms timer. That delay is there to emulate
 * NUI latency, which is a reasonable thing to emulate for a *reply* and actively wrong
 * for the initial state: `visible` already starts `true` in a browser, so the delayed
 * `setVisible: true` changes nothing you can see — unless you closed the phone inside
 * that first second, in which case it silently reopens under you.
 *
 * That was a real dev annoyance and an invisible test race. `keybinds.spec.ts` pressed
 * Escape immediately after load and lost whenever the machine was busy enough to push
 * its assertion past the one-second mark, which read as a flaky test rather than as the
 * seed reopening the phone. `nui.spec.ts` dispatches its own `setVisible` and could
 * have been clobbered the same way.
 */
export function seedBrowserPhone(now: Date): void {
  debugData(
    [
      { action: 'setVisible', data: true },
      { action: 'setTime', data: { hours: now.getHours(), minutes: now.getMinutes() } }
    ],
    0
  );
}

/**
 * `localhost:5173/?app=journal` boots straight into an app.
 *
 * There was no way to do this: `main.ts` mounts the shell and nothing else, so every
 * look at an app — and all thirteen specs in `e2e/apps/` — went through the launcher.
 * For an app author that is the inner loop, run on every reload.
 *
 * Resolved against the *component* registry rather than the installed list, so an app
 * with `core: false` opens without being installed from the Store first. That is
 * the case that hurt most: `notes.spec.ts` reinstalls Notes through the Store on every
 * run to get at it.
 *
 * Pairs with `?state=fresh`, handled in `nui/mocks/registry.ts`, which presents the phone
 * as never used — `?app=blabber&state=fresh` is Blabber's first-run screen. Deliberately a
 * separate axis: opening an app to look at populated data is the ordinary case, so `?app=`
 * on its own keeps the fixtures.
 */
function openDeepLinkedApp(): void {
  const requested = new URLSearchParams(window.location.search).get('app');
  if (!requested) return;

  // `openApp` lowercases before it looks anything up, so match what it will actually
  // resolve. An id with capitals in it opens nothing — see §4.2 — and the warning here
  // is the only thing that would tell you why.
  const id = requested.toLowerCase();
  if (!appRegistryStore.getComponent(id)) {
    console.warn(`[gPhone] ?app=${requested}: no app is registered under '${id}'.`);
    return;
  }

  openApp(id);
}

/** `window.triggerTestToast('call')` from the console. Dev builds only. */
export function installDevHarness(): void {
  /**
   * Fire a server push without a server.
   *
   * `window.pushAppEvent('blabber', 'mention', { blab_id: 1 })` from the console. It posts the
   * real `appEvent` message down the real path, rather than reaching into the bus — a harness
   * that bypassed the parsing would let a malformed envelope look fine in `pnpm dev`.
   *
   * Without this every add-on author is blind in the browser, which is the mirror image of the
   * mock-registry problem §8 warns about.
   */
  window.pushAppEvent = (app: string, event: string, payload = {}, notify?: unknown) => {
    window.postMessage(
      { action: 'appEvent', data: { app, event, payload, at: Date.now(), notify } },
      '*'
    );
  };

  if (!import.meta.env.DEV) return;

  window.triggerTestToast = (type: TestToast = 'message') => {
    const fixture = FIXTURES[type];
    if (!fixture) return;
    window.postMessage(fixture, '*');
  };

  // So a test can install an app the repo does not ship. `error_boundary.spec.ts` needs
  // an app that crashes on render, and there is deliberately no such app in `apps/` —
  // it would appear on every player's home screen. The spec has always read this
  // property; nothing ever assigned it, so its assertions never ran.
  window.appRegistryStore = appRegistryStore;

  openDeepLinkedApp();
}
