// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  __resetAppEvents,
  clearAppEvents,
  deliverAppEvent,
  observeAppEvents,
  subscribeAppEvent,
  type AppEventSighting
} from './appEvents';

/**
 * The bus a pushed event lands on.
 *
 * The property worth holding: the CEF page never unloads, so a module-scope subscription outlives
 * every open/close of the phone, and a component-scope one gets replayed whatever arrived while
 * it was unmounted. Between them, app residency stops being a delivery problem.
 */

const envelope = (app: string, event: string, payload: Record<string, unknown> = {}) => ({
  app,
  event,
  payload,
  at: 1
});

beforeEach(() => __resetAppEvents());

describe('delivery', () => {
  it('hands an event to a listener', () => {
    const seen: unknown[] = [];
    subscribeAppEvent('blabber', 'mention', (e) => seen.push(e));

    deliverAppEvent(envelope('blabber', 'mention', { blab_id: 7 }));

    expect(seen).toEqual([
      { app: 'blabber', event: 'mention', payload: { blab_id: 7 }, at: 1, replayed: false }
    ]);
  });

  it('reaches a wildcard listener too', () => {
    const seen: string[] = [];
    subscribeAppEvent('blabber', '*', (e) => seen.push(e.event));

    deliverAppEvent(envelope('blabber', 'mention'));
    deliverAppEvent(envelope('blabber', 'dm'));

    expect(seen).toEqual(['mention', 'dm']);
  });

  it('does not cross apps', () => {
    const seen: string[] = [];
    subscribeAppEvent('blabber', '*', (e) => seen.push(e.event));

    deliverAppEvent(envelope('marketplace', 'sold'));

    expect(seen).toEqual([]);
  });

  it('keeps delivering after one handler throws', () => {
    // One app's broken handler must not stop another's, and must not stop the buffer working.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    subscribeAppEvent('blabber', 'mention', () => {
      throw new Error('boom');
    });
    subscribeAppEvent('blabber', 'mention', (e) => seen.push(e.event));

    deliverAppEvent(envelope('blabber', 'mention'));

    expect(seen).toEqual(['mention']);
  });
});

describe('buffering', () => {
  it('replays what arrived before anyone was listening', () => {
    // The case that makes a component-scope subscription safe: an app that was not mounted when
    // the event landed still sees it on the way in.
    deliverAppEvent(envelope('blabber', 'mention', { blab_id: 1 }));

    const seen: { event: string; replayed: boolean }[] = [];
    subscribeAppEvent('blabber', 'mention', (e) =>
      seen.push({ event: e.event, replayed: e.replayed })
    );

    expect(seen).toEqual([{ event: 'mention', replayed: true }]);
  });

  it('flags a replay, so a catch-up is not mistaken for a live notification', () => {
    deliverAppEvent(envelope('blabber', 'mention'));
    let replayed: boolean | null = null;
    subscribeAppEvent('blabber', 'mention', (e) => (replayed = e.replayed));

    expect(replayed).toBe(true);
  });

  it('does not replay the same event to a second subscriber', () => {
    // Taken off the buffer when the first subscriber receives it, or every later listener would
    // re-count an event that has already been handled.
    deliverAppEvent(envelope('blabber', 'mention'));

    const first: unknown[] = [];
    const second: unknown[] = [];
    subscribeAppEvent('blabber', 'mention', (e) => first.push(e));
    subscribeAppEvent('blabber', 'mention', (e) => second.push(e));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('replays only the matching event name', () => {
    deliverAppEvent(envelope('blabber', 'mention'));
    deliverAppEvent(envelope('blabber', 'dm'));

    const seen: string[] = [];
    subscribeAppEvent('blabber', 'dm', (e) => seen.push(e.event));

    expect(seen).toEqual(['dm']);
  });

  it('caps the buffer and says so, rather than dropping silently', () => {
    // A silent drop makes a missing notification indistinguishable from one that never arrived.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 30; i++) deliverAppEvent(envelope('blabber', 'mention', { i }));

    const seen: number[] = [];
    subscribeAppEvent('blabber', 'mention', (e) => seen.push((e.payload as { i: number }).i));

    expect(seen).toHaveLength(25);
    // Oldest dropped, newest kept.
    expect(seen[seen.length - 1]).toBe(29);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('buffered'));
  });

  it('clears a buffer once a fetch has made it redundant', () => {
    deliverAppEvent(envelope('blabber', 'mention'));
    clearAppEvents('blabber');

    const seen: unknown[] = [];
    subscribeAppEvent('blabber', 'mention', (e) => seen.push(e));

    expect(seen).toEqual([]);
  });

  it('stops delivering after unsubscribe', () => {
    const seen: unknown[] = [];
    const off = subscribeAppEvent('blabber', 'mention', (e) => seen.push(e));
    off();

    deliverAppEvent(envelope('blabber', 'mention'));

    expect(seen).toEqual([]);
  });
});

describe('a new app joins without editing the shell', () => {
  it('delivers to an app id that appears in no list anywhere', () => {
    /**
     * The property in one assertion.
     *
     * `shell/nuiMessages.ts` used to be a closed table of nine names, and an add-on installed
     * from the Store physically cannot edit it — apps may import nothing outside `@mica/sdk`.
     * So the test is that a completely unknown app id, registered purely at runtime, receives
     * its own events.
     */
    const seen: string[] = [];
    subscribeAppEvent('not_a_real_app', 'anything', (e) => seen.push(e.event));

    deliverAppEvent(envelope('not_a_real_app', 'anything'));

    expect(seen).toEqual(['anything']);
  });
});

/**
 * MICA-338. `('*', '*')` is how the shell watches every push — `services/notifications.ts`
 * refreshes the shade and the badges off it. The lookup used to try only the envelope's own app,
 * so that subscriber had never fired for a real push. Every envelope here is a real app's: a
 * delivery under app `'*'` is the shape that hid the bug, since the server never sends one.
 */
describe('the every-app observer (MICA-338)', () => {
  it('receives a push for any app', () => {
    const seen: string[] = [];
    subscribeAppEvent('*', '*', (e) => seen.push(`${e.app}:${e.event}`));

    deliverAppEvent(envelope('blabber', 'mention'));
    deliverAppEvent(envelope('mail', 'received'));

    expect(seen).toEqual(['blabber:mention', 'mail:received']);
  });

  it('does not count as the consumer, so the event still replays to its own app', () => {
    // The naive fix marks every event taken and empties the buffer that holds events for apps
    // not yet mounted. Observing a push is not handling it.
    const observed: string[] = [];
    subscribeAppEvent('*', '*', (e) => observed.push(e.event));

    deliverAppEvent(envelope('blabber', 'mention', { blab_id: 3 }));

    const seen: { payload: unknown; replayed: boolean }[] = [];
    subscribeAppEvent('blabber', 'mention', (e) =>
      seen.push({ payload: e.payload, replayed: e.replayed })
    );

    expect(observed).toEqual(['mention']);
    expect(seen).toEqual([{ payload: { blab_id: 3 }, replayed: true }]);
  });

  it("runs after the app's own handlers, and once", () => {
    const order: string[] = [];
    subscribeAppEvent('*', '*', () => order.push('observer'));
    subscribeAppEvent('blabber', 'mention', () => order.push('exact'));
    subscribeAppEvent('blabber', '*', () => order.push('app-wide'));

    deliverAppEvent(envelope('blabber', 'mention'));

    expect(order).toEqual(['exact', 'app-wide', 'observer']);
  });

  it("is replayed nothing on subscribe, and drains no app's buffer", () => {
    // Replaying every app's buffer to the observer would take each event off it — the same
    // bug as counting the observer as the consumer, one step later.
    deliverAppEvent(envelope('blabber', 'mention'));

    const observed: unknown[] = [];
    subscribeAppEvent('*', '*', (e) => observed.push(e));

    const seen: unknown[] = [];
    subscribeAppEvent('blabber', 'mention', (e) => seen.push(e));

    expect(observed).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('hands the observer its own copy, so it cannot rewrite what the app replays', () => {
    subscribeAppEvent('*', '*', (e) => {
      e.payload.blab_id = 999;
      (e as { replayed: boolean }).replayed = true;
    });

    deliverAppEvent(envelope('blabber', 'mention', { blab_id: 3 }));

    const seen: { payload: unknown; replayed: boolean }[] = [];
    subscribeAppEvent('blabber', 'mention', (e) =>
      seen.push({ payload: e.payload, replayed: e.replayed })
    );
    expect(seen).toEqual([{ payload: { blab_id: 3 }, replayed: true }]);
  });

  it("stops neither the app's handler nor the buffer when it throws", () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    subscribeAppEvent('*', '*', () => {
      throw new Error('boom');
    });
    const live: string[] = [];
    subscribeAppEvent('blabber', 'mention', (e) => live.push(e.event));

    deliverAppEvent(envelope('blabber', 'mention'));
    deliverAppEvent(envelope('mail', 'received'));

    const replayed: string[] = [];
    subscribeAppEvent('mail', 'received', (e) => replayed.push(e.event));
    expect(live).toEqual(['mention']);
    expect(replayed).toEqual(['received']);
  });

  it("leaves ('*', name) as it was: it does not match that name in every app", () => {
    const seen: string[] = [];
    subscribeAppEvent('*', 'mention', (e) => seen.push(e.app));

    deliverAppEvent(envelope('blabber', 'mention'));

    expect(seen).toEqual([]);
  });

  it("leaves (app, '*') scoped to its own app with an observer present", () => {
    // What an add-on's `appEvents.onAny` builds: `IframeHostServer` replaces the frame's app id
    // with its own manifest id, which `sdk/manifest.ts` holds to `^[a-z][a-z0-9_]*$` — never
    // `'*'`. So the observer is out of an add-on's reach, and this is all it can subscribe to.
    subscribeAppEvent('*', '*', () => {});
    const seen: string[] = [];
    subscribeAppEvent('probe', '*', (e) => seen.push(`${e.app}:${e.event}`));

    deliverAppEvent(envelope('blabber', 'mention'));
    deliverAppEvent(envelope('probe', 'ping'));

    expect(seen).toEqual(['probe:ping']);
  });
});

/**
 * MICA-365. A payload-blind observer: told which app, which event and whether a row was stored,
 * never the payload — so the bus clones nothing for it. Same position as the `('*', '*')`
 * observer: it never takes an event, and is replayed nothing.
 */
describe('the payload-blind observer (MICA-365)', () => {
  it('sees every app with its persisted flag, and no payload', () => {
    const seen: AppEventSighting[] = [];
    observeAppEvents((s) => seen.push(s));

    deliverAppEvent({ ...envelope('blabber', 'mention', { blab_id: 1 }), persisted: true });
    deliverAppEvent(envelope('liveloc', 'tick'));

    expect(seen).toEqual([
      { app: 'blabber', event: 'mention', persisted: true },
      { app: 'liveloc', event: 'tick', persisted: false }
    ]);
    expect(seen[0]).not.toHaveProperty('payload');
  });

  it('clones no payload for it', () => {
    const clone = vi.spyOn(globalThis, 'structuredClone');
    observeAppEvents(() => {});

    deliverAppEvent({ ...envelope('blabber', 'mention', { blab_id: 1 }), persisted: true });

    expect(clone).not.toHaveBeenCalled();
    clone.mockRestore();
  });

  it('does not take the event, so its own app still replays it', () => {
    observeAppEvents(() => {});
    deliverAppEvent({ ...envelope('blabber', 'mention', { blab_id: 3 }), persisted: true });

    const replayed: boolean[] = [];
    subscribeAppEvent('blabber', 'mention', (e) => replayed.push(e.replayed));
    expect(replayed).toEqual([true]);
  });

  it('keeps delivering when one throws, and stops after unsubscribe', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    observeAppEvents(() => {
      throw new Error('boom');
    });
    const seen: string[] = [];
    const off = observeAppEvents((s) => seen.push(s.event));

    deliverAppEvent(envelope('blabber', 'one'));
    off();
    deliverAppEvent(envelope('blabber', 'two'));

    expect(seen).toEqual(['one']);
    vi.restoreAllMocks();
  });
});
