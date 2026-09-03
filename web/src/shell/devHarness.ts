// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { debugData } from '../lib/phone/debug';
import type { DeviceId } from '@gphone/shared/devices';
import { placeholderAvatar } from '@gphone/sdk';
import { appRegistryStore } from './state/registry';
import { openApp } from './state/navigation';
import { fetchNui } from '../nui/fetchNui';
import {
  MUSIC_BROADCASTS_NUI_ACTION,
  MUSIC_BROADCAST_VOLUMES_NUI_ACTION
} from '@gphone/shared/musicBroadcast';

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
      avatar: placeholderAvatar('Ursula')
    }
  },
  contact: {
    action: 'shareContact',
    // MICA-155: `sender` is a distinct identity from the card's own claimed name on
    // purpose — this fixture is what dev/e2e exercises the "who actually sent this"
    // toast copy against, so a card and a sender that agree would leave that path
    // untested in the browser.
    data: {
      firstname: 'Franklin',
      lastname: 'Clinton',
      phone: '555-0177',
      sender: { citizenid: 'DEV1', name: 'Lamar Davis', phone: '555-0188' }
    }
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
 * for the initial state: `Shell` already opens itself in a browser from `onMount`
 * (MICA-86), so the `setVisible: true` here changes nothing you can see — unless you
 * closed the phone inside that first second, in which case it silently reopens under you.
 *
 * It is kept rather than dropped because it is not only about `visible`: this is the one
 * place a browser session gets a `setVisible` through the real `handleMessage` path at
 * all, so removing it would take the browser further from what the client actually sends.
 *
 * That was a real dev annoyance and an invisible test race. `keybinds.spec.ts` pressed
 * Escape immediately after load and lost whenever the machine was busy enough to push
 * its assertion past the one-second mark, which read as a flaky test rather than as the
 * seed reopening the phone. `nui.spec.ts` dispatches its own `setVisible` and could
 * have been clobbered the same way.
 */
export function seedBrowserPhone(now: Date, device: DeviceId): void {
  debugData(
    [
      // The device the shell already chose (`?device=`, MICA-259), never a bare `true`:
      // that spelling means the phone, and would put a tablet session back on the phone
      // through the one path this seed exists to exercise.
      { action: 'setVisible', data: { device, visible: true } },
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
  // `isKnownApp`, not `getComponent`. Components load on demand, so nothing is resolved at
  // boot and asking whether one is loaded would refuse every app here — `openApp` fetches
  // the chunk itself.
  if (!appRegistryStore.isKnownApp(id)) {
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

  /**
   * Put somebody else's music next to you, without a server or a game.
   *
   * `window.pushNearbyMusic([{ id: 'a', videoId: 'dQw4w9WgXcQ', volume: 0.8 }])` from the
   * console. The two real messages are posted down the real path — the roster the server
   * sends and the volume map the game client sends — rather than reaching into the stores,
   * for the same reason `pushAppEvent` does it that way: a harness that skipped the parsing
   * would let a malformed payload look fine in `pnpm dev` and be dead in game.
   *
   * It also fills in the two identities so a caller does not have to think about them, and
   * fills them in **separately**: `token` is the mute key and `source` is what the volume
   * map is keyed on. Handing back one value for both would make the join in
   * `state/nearbyMusic.ts` impossible to get wrong by hand, which is the opposite of what
   * a harness is for.
   *
   * `volume` is the one field this invents, because in a browser there is no distance to
   * compute one from. It defaults to full: the point of calling this is to hear something.
   * Call with `[]` to make everybody walk away.
   */
  window.pushNearbyMusic = (rows = []) => {
    const broadcasts = rows.map((row, i) => ({
      source: row.source ?? 900 + i,
      token: row.token ?? `dev${i}`,
      label: row.label ?? null,
      videoId: row.videoId ?? null,
      playlistId: row.playlistId ?? null,
      startedAt: row.startedAt ?? Date.now(),
      paused: row.paused ?? false
    }));
    const volumes = Object.fromEntries(
      broadcasts.map((b, i) => [String(b.source), rows[i].volume ?? 1])
    );
    window.postMessage({ action: MUSIC_BROADCASTS_NUI_ACTION, data: { broadcasts } }, '*');
    window.postMessage({ action: MUSIC_BROADCAST_VOLUMES_NUI_ACTION, data: { volumes } }, '*');
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

  // So a spec can make a NUI call by name, without a UI path to it. `nui.spec.ts` uses
  // it to call an action no mock answers and prove that the fixture in
  // `web/e2e/support/test.ts` fails the spec that did it (MICA-195) — the one spec in
  // the suite that must go red, and that nothing on the phone's own surface can provoke,
  // because every action the phone reaches has a mock by construction.
  window.fetchNui = fetchNui;

  openDeepLinkedApp();
}
