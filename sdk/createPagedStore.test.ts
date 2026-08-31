import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { createPagedStore } from './createPagedStore';
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
