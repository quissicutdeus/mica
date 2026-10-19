// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { createPagedStore } from './createPagedStore';
import { forgetCharacterStores, keepAcrossCharacters } from './characterStores';
import { ServiceRefusal } from './lib/errors';
import { GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';
import { defineAddonService, addonOutput } from '@mica/shared/addonService';
/**
 * MICA-172: the stub point is `sdk/nui/transport`, not `nui/fetchNui`.
 *
 * The code under test reaches the transport through the SDK's seam now, so spying on the
 * phone's own `fetchNui` module replaces a binding nothing calls — the real transport runs
 * and the failure reads as fixture trouble rather than as a stub that never applied. Stub
 * the seam and both sides of it are covered.
 */
import * as fetchNuiModule from './nui/transport';

type Row = { id: number; label: string };

beforeEach(() => vi.restoreAllMocks());

describe('createPagedStore', () => {
  it('loads a first page and tracks the cursor', async () => {
    const store = createPagedStore<Row>('getFeed');
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
      rows: [{ id: 2, label: 'b' }],
      nextCursor: 2
    });

    await store.load();

    expect(get(store)).toEqual([{ id: 2, label: 'b' }]);
    expect(get(store.hasMore)).toBe(true);
    expect(get(store.loaded)).toBe(true);
  });

  it('reads through a function instead of a NUI action, paging the same way', async () => {
    // The door an add-on has to a *shared* service: a named NUI action is refused inside the
    // sandbox and the generic service route is pinned to the app's own namespace, so the
    // page comes from the facet function itself (`useAccounts().getFollowers`).
    const nui = vi.spyOn(fetchNuiModule, 'fetchNui');
    const read = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 2, label: 'b' }], nextCursor: 2 })
      .mockResolvedValueOnce({ rows: [{ id: 1, label: 'a' }], nextCursor: null });
    const store = createPagedStore<Row>(read, { pageSize: 30 });

    await store.load({ account_id: 7 });
    expect(read).toHaveBeenCalledWith({ account_id: 7, cursor: undefined, limit: 30 });
    expect(get(store)).toEqual([{ id: 2, label: 'b' }]);
    expect(get(store.hasMore)).toBe(true);

    expect(await store.loadMore()).toBe(true);
    expect(read).toHaveBeenLastCalledWith({ account_id: 7, cursor: 2, limit: 30 });
    expect(get(store)).toEqual([
      { id: 2, label: 'b' },
      { id: 1, label: 'a' }
    ]);
    expect(get(store.hasMore)).toBe(false);
    // The whole point: nothing went near `fetchNui`, which is what the wall refuses.
    expect(nui).not.toHaveBeenCalled();
  });

  it('keeps the last known page when the reader throws, rather than emptying the list', async () => {
    // Why `services/accounts.ts`'s `getFollowers`/`getFollowing` pass no `defaultValue`: a
    // reader that answers `{ rows: [] }` on a transport failure is indistinguishable from a
    // genuinely empty list, and the store would replace a good window with a false one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 2, label: 'b' }], nextCursor: null })
      .mockRejectedValueOnce(new Error('refused'));
    const store = createPagedStore<Row>(read);

    await store.load();
    expect(get(store)).toEqual([{ id: 2, label: 'b' }]);

    await store.load();

    expect(get(store)).toEqual([{ id: 2, label: 'b' }]);
    expect(warn).toHaveBeenCalled();
  });

  it('appends the next page on loadMore', async () => {
    const store = createPagedStore<Row>('getFeed');
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui');
    spy.mockResolvedValueOnce({ rows: [{ id: 2, label: 'b' }], nextCursor: 2 });
    await store.load();

    spy.mockResolvedValueOnce({ rows: [{ id: 1, label: 'a' }], nextCursor: null });
    const appended = await store.loadMore();

    expect(appended).toBe(true);
    expect(get(store)).toEqual([
      { id: 2, label: 'b' },
      { id: 1, label: 'a' }
    ]);
    expect(get(store.hasMore)).toBe(false);
  });

  it('keeps the existing page when a background refresh fails', async () => {
    // fetchNui's real contract: throw when no `defaultValue` was given, return the
    // default when one was — a store that still hardcodes `defaultValue: { rows: [],
    // nextCursor: null }` gets a silent empty page here, exactly as it would in
    // production from a transport failure or a 15s ServiceProxy timeout.
    const store = createPagedStore<Row>('getFeed');
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui');

    spy.mockResolvedValueOnce({ rows: [{ id: 2, label: 'b' }], nextCursor: 2 });
    await store.load();
    expect(get(store)).toEqual([{ id: 2, label: 'b' }]);

    spy.mockImplementationOnce(async (_event, _payload, opts) => {
      if (opts && 'defaultValue' in opts) return opts.defaultValue;
      throw new Error('Request timed out');
    });
    await store.load();

    expect(get(store)).toEqual([{ id: 2, label: 'b' }]);
    expect(get(store.hasMore)).toBe(true);
    expect(get(store.loaded)).toBe(true);
  });

  it('leaves the cursor untouched when loadMore fails, so the next attempt can retry', async () => {
    const store = createPagedStore<Row>('getFeed');
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui');

    spy.mockResolvedValueOnce({ rows: [{ id: 2, label: 'b' }], nextCursor: 2 });
    await store.load();

    spy.mockImplementationOnce(async (_event, _payload, opts) => {
      if (opts && 'defaultValue' in opts) return opts.defaultValue;
      throw new Error('Request timed out');
    });
    const appended = await store.loadMore();

    expect(appended).toBe(false);
    expect(get(store)).toEqual([{ id: 2, label: 'b' }]);
    expect(get(store.hasMore)).toBe(true);

    // A retry from the same, unmoved cursor succeeds normally.
    spy.mockResolvedValueOnce({ rows: [{ id: 1, label: 'a' }], nextCursor: null });
    const retried = await store.loadMore();
    expect(retried).toBe(true);
    expect(get(store)).toEqual([
      { id: 2, label: 'b' },
      { id: 1, label: 'a' }
    ]);
  });

  /** Resolves and rejects on demand, so a test can control exactly when each reply lands. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  describe('MICA-117: load/loadMore interleaving', () => {
    it('drops a loadMore that resolves after a load has already landed', async () => {
      const store = createPagedStore<Row>('getFeed');
      const spy = vi.spyOn(fetchNuiModule, 'fetchNui');

      // Prime the store with a first page so loadMore has a cursor to start from.
      spy.mockResolvedValueOnce({ rows: [{ id: 9, label: 'primed' }], nextCursor: 9 });
      await store.load();

      const loadMoreReply = deferred<{ rows: Row[]; nextCursor: number | null }>();
      const loadReply = deferred<{ rows: Row[]; nextCursor: number | null }>();
      spy.mockReturnValueOnce(loadMoreReply.promise);
      spy.mockReturnValueOnce(loadReply.promise);

      // loadMore starts first — the ordinary path in (camera reopened from gallery while a
      // scroll-triggered loadMore is still in flight).
      const loadMorePromise = store.loadMore();
      // load lands while that loadMore is still awaiting its reply.
      const loadPromise = store.load();
      loadReply.resolve({ rows: [{ id: 1, label: 'page one' }], nextCursor: 1 });
      await loadPromise;

      // The window is exactly load's page one, with load's cursor — before the stale
      // loadMore reply has even arrived yet.
      expect(get(store)).toEqual([{ id: 1, label: 'page one' }]);
      expect(get(store.hasMore)).toBe(true);

      // Now the superseded loadMore finally resolves. It must not append its rows onto the
      // window `load` just replaced, or overwrite the cursor/hasMore load just set.
      loadMoreReply.resolve({ rows: [{ id: 8, label: 'stale' }], nextCursor: 8 });
      expect(await loadMorePromise).toBe(false);

      expect(get(store)).toEqual([{ id: 1, label: 'page one' }]);
      expect(get(store.hasMore)).toBe(true);

      // The window is still healthy — a real loadMore now continues from load's cursor (1),
      // not the stale one (8) the dropped reply tried to install.
      spy.mockResolvedValueOnce({ rows: [{ id: 0, label: 'page two' }], nextCursor: null });
      expect(await store.loadMore()).toBe(true);
      expect(spy).toHaveBeenLastCalledWith('getFeed', { cursor: 1, limit: undefined });
      expect(get(store)).toEqual([
        { id: 1, label: 'page one' },
        { id: 0, label: 'page two' }
      ]);
    });

    it('lets the later of two overlapping loads win, dropping the earlier reply', async () => {
      const store = createPagedStore<Row>('getFeed');
      const spy = vi.spyOn(fetchNuiModule, 'fetchNui');

      const firstReply = deferred<{ rows: Row[]; nextCursor: number | null }>();
      const secondReply = deferred<{ rows: Row[]; nextCursor: number | null }>();
      spy.mockReturnValueOnce(firstReply.promise);
      spy.mockReturnValueOnce(secondReply.promise);

      const firstLoad = store.load({ tab: 'first' });
      const secondLoad = store.load({ tab: 'second' });

      // The later call's reply lands first — still must win, because it started last.
      secondReply.resolve({ rows: [{ id: 2, label: 'second' }], nextCursor: 2 });
      await secondLoad;
      expect(get(store)).toEqual([{ id: 2, label: 'second' }]);

      firstReply.resolve({ rows: [{ id: 1, label: 'first' }], nextCursor: 1 });
      await firstLoad;

      // The earlier reply landing after the later one changes nothing.
      expect(get(store)).toEqual([{ id: 2, label: 'second' }]);
      expect(get(store.hasMore)).toBe(true);
      expect(get(store.loaded)).toBe(true);
    });
  });

  describe('MICA-119: prepend racing a load', () => {
    it('replaces in place rather than duplicating a row a racing load already pulled in', async () => {
      // The caller's own create round trip and a `load()` triggered elsewhere are
      // independent. If the load's reply lands — and already contains the row the server
      // just created — before the caller's optimistic `prepend` runs, unshifting it
      // unconditionally would show the row twice.
      const store = createPagedStore<Row>('getFeed');
      const spy = vi.spyOn(fetchNuiModule, 'fetchNui');

      spy.mockResolvedValueOnce({ rows: [{ id: 5, label: 'x' }], nextCursor: null });
      await store.load();
      expect(get(store)).toEqual([{ id: 5, label: 'x' }]);

      // The create's own reply lands afterward; the caller prepends what it was given,
      // unaware the racing load already put the same row in the window.
      store.prepend({ id: 5, label: 'x (from create)' });

      expect(get(store)).toEqual([{ id: 5, label: 'x (from create)' }]);
    });

    it('still unshifts a genuinely new row', () => {
      const store = createPagedStore<Row>('getFeed');
      store.prepend({ id: 1, label: 'first' });
      store.prepend({ id: 2, label: 'second' });

      expect(get(store)).toEqual([
        { id: 2, label: 'second' },
        { id: 1, label: 'first' }
      ]);
    });
  });

  describe('MICA-118: cursor/hasMore agreement after a failed first-page load', () => {
    it('leaves cursor and hasMore agreeing, so loadMore actually retries instead of being wired to false forever', async () => {
      const store = createPagedStore<Row>('getFeed');
      const spy = vi.spyOn(fetchNuiModule, 'fetchNui');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      spy.mockResolvedValueOnce({ rows: [{ id: 2, label: 'b' }], nextCursor: 2 });
      await store.load();
      expect(get(store.hasMore)).toBe(true);

      // A refresh (server busy, fetchNui timeout, service throw) fails outright.
      spy.mockRejectedValueOnce(new Error('refused'));
      await store.load();

      expect(warn).toHaveBeenCalled();
      // hasMore is still true from the last good page — if cursor had been cleared to null
      // up front and never restored, loadMore below would be wired to return false forever
      // with nothing logged, since its `cursor === null` guard would refuse to even try.
      expect(get(store.hasMore)).toBe(true);

      spy.mockResolvedValueOnce({ rows: [{ id: 1, label: 'a' }], nextCursor: null });
      const more = await store.loadMore();

      expect(more).toBe(true);
      expect(spy).toHaveBeenLastCalledWith('getFeed', { cursor: 2, limit: undefined });
      expect(get(store)).toEqual([
        { id: 2, label: 'b' },
        { id: 1, label: 'a' }
      ]);
    });
  });
});

/**
 * MICA-384: a failed page is not an answer, and one character's window is not the next one's.
 * Failures are stubbed the way `fetchNui` really fails — the default when one was asked for,
 * a throw otherwise — not with a bare rejection.
 */
describe('createPagedStore when a page fails or the character changes', () => {
  const failLikeFetchNui = async (
    _event: string,
    _data?: unknown,
    options?: { defaultValue?: unknown }
  ): Promise<unknown> => {
    if (options && 'defaultValue' in options) return options.defaultValue;
    throw new Error('Request timed out');
  };
  const page = (ids: number[], nextCursor: number | null = null) => ({
    rows: ids.map((id) => ({ id, label: `row ${id}` })),
    nextCursor
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('leaves a store whose first page failed not loaded, and the next load retries', async () => {
    const store = createPagedStore<Row>('getFeed');
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementationOnce(failLikeFetchNui);

    await store.load();
    expect(get(store.loaded)).toBe(false);
    expect(get(store)).toEqual([]);

    spy.mockResolvedValueOnce(page([1]));
    await store.load();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(get(store.loaded)).toBe(true);
    expect(get(store).map((r) => r.id)).toEqual([1]);
  });

  it('keeps the last window, still loaded, when a later page fails', async () => {
    const store = createPagedStore<Row>('getFeed');
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValueOnce(page([2], 2));
    await store.load();

    spy.mockImplementationOnce(failLikeFetchNui);
    await store.load();

    expect(get(store).map((r) => r.id)).toEqual([2]);
    expect(get(store.loaded)).toBe(true);
    expect(get(store.hasMore)).toBe(true);
  });

  it('treats a reply that is not a page as a failure, not as an empty last page', async () => {
    // `{ error }` is what a refused read looks like after `call`. Read as a page it was an
    // empty feed with `nextCursor: null`, which also ended paging.
    const store = createPagedStore<Row>('getFeed');
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValueOnce({ error: 'nope' });

    await store.load();
    expect(get(store.loaded)).toBe(false);

    spy.mockResolvedValueOnce(page([2], 2));
    await store.load();
    spy.mockResolvedValueOnce(null);
    await store.load();
    spy.mockResolvedValueOnce({ error: 'nope' });
    expect(await store.loadMore()).toBe(false);

    expect(get(store).map((r) => r.id)).toEqual([2]);
    expect(get(store.hasMore)).toBe(true);
  });

  it('forgetCharacterStores empties the window, its cursor and its loaded flag', async () => {
    const messages = createPagedStore<Row>('getFeed');
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValueOnce(page([2], 2));
    await messages.load();

    forgetCharacterStores();

    expect(get(messages)).toEqual([]);
    expect(get(messages.loaded)).toBe(false);
    expect(get(messages.hasMore)).toBe(false);
    // No cursor left over from the last character to page on from.
    expect(await messages.loadMore()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);

    // And the next character's failed first page leaves it empty, not the last one's.
    spy.mockImplementationOnce(failLikeFetchNui);
    await messages.load();
    expect(get(messages)).toEqual([]);
    expect(get(messages.loaded)).toBe(false);
  });

  it('drops a page that was in flight across the forget, and lets the next load run', async () => {
    const store = createPagedStore<Row>('getFeed');
    let answer!: (reply: ReturnType<typeof page>) => void;
    const spy = vi
      .spyOn(fetchNuiModule, 'fetchNui')
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));

    const loading = store.load();
    forgetCharacterStores();
    answer(page([1], 1));
    await loading;

    expect(get(store)).toEqual([]);
    expect(get(store.loaded)).toBe(false);

    // And the store pages normally for the next character.
    spy.mockResolvedValueOnce(page([5], 5)).mockResolvedValueOnce(page([4]));
    await store.load();
    expect(await store.loadMore()).toBe(true);
    expect(get(store).map((r) => r.id)).toEqual([5, 4]);
  });

  it('leaves a store that opted out untouched', async () => {
    const shared = keepAcrossCharacters(createPagedStore<Row>('getFeed'));
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValueOnce(page([1]));
    await shared.load();

    forgetCharacterStores();

    expect(get(shared).map((r) => r.id)).toEqual([1]);
    expect(get(shared.loaded)).toBe(true);
  });
});

/** As `createCrudStore`'s: what tells a refused page from a slow one. */
describe('createPagedStore error', () => {
  const page = (ids: number[], nextCursor: number | null = null) => ({
    rows: ids.map((id) => ({ id, label: `row ${id}` })),
    nextCursor
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('sets error on a refused first page, leaves loaded false, and a later page clears it', async () => {
    const store = createPagedStore<Row>('getFeed');
    const spy = vi
      .spyOn(fetchNuiModule, 'fetchNui')
      .mockRejectedValueOnce(new ServiceRefusal('server.rateLimited', 'Slow down a little.'));
    expect(get(store.error)).toBeNull();

    await expect(store.load()).resolves.toBeUndefined();
    expect(get(store.error)).toBe('Slow down a little.');
    expect(get(store.loaded)).toBe(false);
    expect(get(store)).toEqual([]);

    spy.mockResolvedValueOnce(page([]));
    await store.load();
    expect(get(store.error)).toBeNull();
    expect(get(store.loaded)).toBe(true);
  });

  it('sets error for a reply that is not a page', async () => {
    const store = createPagedStore<Row>('getFeed');
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValueOnce({ error: 'nope' });

    await store.load();
    expect(get(store.error)).toBe(`'getFeed' answered something not a page`);
    expect(get(store.loaded)).toBe(false);
  });

  it('sets error when loadMore fails, keeps the window, and the retry clears it', async () => {
    const store = createPagedStore<Row>('getFeed');
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValueOnce(page([2], 2));
    await store.load();

    spy.mockRejectedValueOnce(new Error('Request timed out'));
    expect(await store.loadMore()).toBe(false);
    expect(get(store.error)).toBe('Request timed out');
    expect(get(store).map((r) => r.id)).toEqual([2]);
    expect(get(store.loaded)).toBe(true);

    spy.mockResolvedValueOnce(page([1]));
    expect(await store.loadMore()).toBe(true);
    expect(get(store.error)).toBeNull();
  });

  it('ignores the failure of a request a newer one superseded', async () => {
    const store = createPagedStore<Row>('getFeed');
    let refuse!: (e: unknown) => void;
    const spy = vi
      .spyOn(fetchNuiModule, 'fetchNui')
      .mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)))
      .mockResolvedValueOnce(page([1]));

    const older = store.load();
    await store.load();
    refuse(new Error('stale failure'));
    await older;

    expect(spy).toHaveBeenCalledTimes(2);
    expect(get(store.error)).toBeNull();
    expect(get(store).map((r) => r.id)).toEqual([1]);
  });

  it('clears error on a forget', async () => {
    const store = createPagedStore<Row>('getFeed');
    vi.spyOn(fetchNuiModule, 'fetchNui').mockRejectedValueOnce(new Error('first'));
    await store.load();
    expect(get(store.error)).toBe('first');

    forgetCharacterStores();
    expect(get(store.error)).toBeNull();
  });

  it('sets error from a reader too', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('refused'));
    const store = createPagedStore<Row>(read);
    await store.load();
    expect(get(store.error)).toBe('refused');
  });
});

/** As `createCrudStore`'s: a string action in a frame needs `service`, or nothing answers. */
describe('createPagedStore in an add-on frame', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('throws at construction for a string action without service, naming the option', () => {
    vi.stubGlobal('origin', 'null');
    expect(() => createPagedStore<Row>('feed')).toThrow(
      /createPagedStore\('feed'\).*\{ service: '<your app id>' \}/
    );
  });

  it('builds with service, from a declaration, or over a reader', async () => {
    vi.stubGlobal('origin', 'null');
    const spy = vi
      .spyOn(fetchNuiModule, 'fetchNui')
      .mockResolvedValue({ rows: [], nextCursor: null });
    const journal = defineAddonService({
      id: 'journal',
      actions: {
        feed: {
          input: { cursor: { type: 'integer', optional: true } },
          output: addonOutput<{ rows: Row[]; nextCursor: number | null }>()
        }
      }
    });

    await createPagedStore<Row>('feed', { service: 'journal' }).load();
    await createPagedStore(journal, 'feed').load();
    const read = vi.fn().mockResolvedValue([]);
    await createPagedStore<Row>(read).load();

    const generic = [
      GENERIC_SERVICE_ACTION,
      { service: 'journal', action: 'feed', data: { cursor: undefined, limit: undefined } }
    ];
    expect(spy.mock.calls).toEqual([generic, generic]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("leaves the phone's own paged stores on NUI action names", async () => {
    vi.stubGlobal('origin', 'https://cfx-nui-mica');
    const spy = vi
      .spyOn(fetchNuiModule, 'fetchNui')
      .mockResolvedValue({ rows: [], nextCursor: null });

    await createPagedStore<Row>('getFeed').load();
    expect(spy).toHaveBeenCalledWith('getFeed', { cursor: undefined, limit: undefined });
  });
});
