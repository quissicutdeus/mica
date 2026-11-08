// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, afterEach } from 'vitest';
import { writable } from 'svelte/store';
import { freshRead, FRESH_FOR_MS } from './freshness';

/** A store and a `load` that answers by setting it, as `createCrudStore`'s does. */
const answering = () => {
  const store = writable<number[]>([]);
  const load = vi.fn(async () => store.set([1]));
  return { store, load };
};

/** A `load` that resolves without setting anything, as a failed read does. */
const failing = () => {
  const store = writable<number[]>([]);
  const load = vi.fn(async () => {});
  return { store, load };
};

// Every test takes its own key: the stamps are module state, by design, so that a
// remounted app still knows when it last read.
let n = 0;
const key = () => `test-${++n}`;

afterEach(() => {
  vi.useRealTimers();
});

describe('freshRead (MICA-446)', () => {
  it('skips a second read while the first answer is fresh', async () => {
    const { store, load } = answering();
    const refresh = freshRead(key(), store, load);

    await refresh();
    await refresh();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reads again once the answer has gone stale', async () => {
    vi.useFakeTimers();
    const { store, load } = answering();
    const refresh = freshRead(key(), store, load);

    await refresh();
    vi.advanceTimersByTime(FRESH_FOR_MS + 1);
    await refresh();

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('retries after a read that never answered', async () => {
    const { store, load } = failing();
    const refresh = freshRead(key(), store, load);

    await refresh();
    await refresh();

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one read between calls made while it is in flight', async () => {
    const { store, load } = answering();
    const refresh = freshRead(key(), store, load);

    await Promise.all([refresh(), refresh()]);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps the stamp across a second instance with the same key — a remounted app', async () => {
    const { store, load } = answering();
    const k = key();

    await freshRead(k, store, load)();
    await freshRead(k, store, load)();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('turns a load that throws into a logged failure, and retries it next time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = writable<number[]>([]);
    const load = vi.fn((): Promise<void> => {
      throw new Error('no facet');
    });
    const refresh = freshRead(key(), store, load);

    await expect(refresh()).resolves.toBeUndefined();
    await refresh();

    expect(load).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
