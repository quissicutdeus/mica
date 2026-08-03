import { describe, it, expect, vi, beforeEach } from 'vitest';
import { __resetAppEvents, clearAppEvents, deliverAppEvent, subscribeAppEvent } from './appEvents';

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
     * from the Store physically cannot edit it — apps may import nothing outside `@gphone/sdk`.
     * So the test is that a completely unknown app id, registered purely at runtime, receives
     * its own events.
     */
    const seen: string[] = [];
    subscribeAppEvent('not_a_real_app', 'anything', (e) => seen.push(e.event));

    deliverAppEvent(envelope('not_a_real_app', 'anything'));

    expect(seen).toEqual(['anything']);
  });
});
