// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/** In-process facets: a unit test stands in for the shell (MICA-176). */
import '../host/registerFacets';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NuiTransportAdapter, setTransport } from './transport';
import { deliverAppEvent } from '../shell/state/appEvents';
import '../services/notifications';

/**
 * MICA-372: a NUI callback the client never answers.
 *
 * Before, `NuiTransportAdapter.send` waited for it forever, and so did everything awaiting
 * it — `notifications.ts` held `refreshing` true for the rest of the session and every push
 * after that was folded into a refresh that would never land. jsdom has no CEF behind
 * `https://mica/…`, so `fetch` is replaced with one that hangs until it is aborted, which is
 * what a callback that never calls `cb()` looks like from this side.
 */

const TIMEOUT_MS = 20_000;

/** A `fetch` that never answers, but honours its signal the way the real one does. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        );
      })
  );
}

/** The `<service>:<action>` names a fetch spy was asked for, in order. */
const actionsOf = (spy: ReturnType<typeof hangingFetch>): string[] =>
  spy.mock.calls.map(([, init]) => {
    const { service, action } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      service?: string;
      action?: string;
    };
    return `${service}:${action}`;
  });

beforeEach(() => {
  vi.useFakeTimers();
  setTransport(new NuiTransportAdapter());
});

afterEach(() => {
  setTransport(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('NuiTransportAdapter timeout (MICA-372)', () => {
  it('rejects a callback that never answers, and only after the timeout', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const outcome = new NuiTransportAdapter().send('neverAnswers', {}).then(
      () => 'resolved',
      (err: Error) => err.message
    );

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    let settled = false;
    void outcome.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatch(/neverAnswers.*did not answer within 20000ms/);
  });

  it('passes a non-timeout failure through unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(new NuiTransportAdapter().send('broken')).rejects.toThrow('Failed to fetch');
  });

  it('clears its timer once the callback answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) })
    );
    await expect(new NuiTransportAdapter().send('answers')).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets the shade refresh again after a hung refresh times out', async () => {
    const fetchSpy = hangingFetch();
    vi.stubGlobal('fetch', fetchSpy);

    deliverAppEvent({ app: 'blabber', event: 'mention', payload: {}, at: Date.now() });
    await vi.advanceTimersByTimeAsync(1_000);
    const first = actionsOf(fetchSpy).filter((a) => a.startsWith('notifications:get'));
    expect(first.sort()).toEqual([
      'notifications:getShadeNotifications',
      'notifications:getUnreadCounts'
    ]);

    // Past the timeout, `refreshing` must have been released: a new push reads again.
    // Before MICA-372 this push was folded into the hung refresh and never read anything.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    fetchSpy.mockClear();
    deliverAppEvent({ app: 'blabber', event: 'mention', payload: {}, at: Date.now() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      actionsOf(fetchSpy)
        .filter((a) => a.startsWith('notifications:get'))
        .sort()
    ).toEqual(['notifications:getShadeNotifications', 'notifications:getUnreadCounts']);

    // Drain the second refresh so it cannot land in another test.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
  });
});
