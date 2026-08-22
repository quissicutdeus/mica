import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { createPagedStore } from './createPagedStore';
import * as fetchNuiModule from '../nui/fetchNui';

type Row = { id: number; label: string };

beforeEach(() => vi.restoreAllMocks());

describe('createPagedStore', () => {
  it('loads a first page and tracks the cursor', async () => {
    const store = createPagedStore<Row>('getFeed');
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
      rows: [{ id: 2, label: 'b' }],
      nextCursor: 2
    } as any);

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
    spy.mockResolvedValueOnce({ rows: [{ id: 2, label: 'b' }], nextCursor: 2 } as any);
    await store.load();

    spy.mockResolvedValueOnce({ rows: [{ id: 1, label: 'a' }], nextCursor: null } as any);
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

    spy.mockResolvedValueOnce({ rows: [{ id: 2, label: 'b' }], nextCursor: 2 } as any);
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

    spy.mockResolvedValueOnce({ rows: [{ id: 2, label: 'b' }], nextCursor: 2 } as any);
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
    spy.mockResolvedValueOnce({ rows: [{ id: 1, label: 'a' }], nextCursor: null } as any);
    const retried = await store.loadMore();
    expect(retried).toBe(true);
    expect(get(store)).toEqual([
      { id: 2, label: 'b' },
      { id: 1, label: 'a' }
    ]);
  });
});
