import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { createCrudStore, byNewest } from './createCrudStore';
import * as fetchNuiModule from '../nui/fetchNui';

type Row = { id: number; label: string; created_at?: string };

const events = { list: 'getRows', create: 'createRow', update: 'updateRow', remove: 'deleteRow' };

beforeEach(() => vi.restoreAllMocks());

describe('createCrudStore', () => {
  it('keeps one order however the list changed', () => {
    // The divergence: Photos sorted on load and unshifted on add, so a row added while
    // the list was on screen was ordered by which code path put it there.
    const store = createCrudStore<Row>('Rows', events, { sort: byNewest<Row>('created_at') });

    const spy = vi.spyOn(fetchNuiModule, 'fetchNui');
    spy.mockResolvedValue([
      { id: 1, label: 'old', created_at: '2026-01-01T00:00:00Z' },
      { id: 2, label: 'new', created_at: '2026-06-01T00:00:00Z' }
    ] as any);

    return store.load().then(async () => {
      expect(get(store).map((r) => r.id)).toEqual([2, 1]);

      spy.mockResolvedValue({ id: 3, label: 'newest', created_at: '2026-09-01T00:00:00Z' } as any);
      await store.add({ label: 'newest' } as any);
      expect(get(store).map((r) => r.id)).toEqual([3, 2, 1]);

      // And an edit that changes the sort key moves the row, rather than leaving it
      // where it happened to be.
      spy.mockResolvedValue(true as any);
      await store.update({ id: 1, label: 'old', created_at: '2026-12-01T00:00:00Z' });
      expect(get(store).map((r) => r.id)).toEqual([1, 3, 2]);
    });
  });

  it('leaves the server order alone when no comparator is given', async () => {
    const store = createCrudStore<Row>('Rows', events);
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue([
      { id: 9, label: 'b' },
      { id: 4, label: 'a' }
    ] as any);

    await store.load();
    expect(get(store).map((r) => r.id)).toEqual([9, 4]);
  });

  it('refuses an invalid write before it reaches the server', async () => {
    const store = createCrudStore<Row>('Rows', events, {
      validate: (draft) => {
        if (!draft.label) throw new Error('A label is required.');
      }
    });
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({} as any);

    await expect(store.add({} as any)).rejects.toThrow('A label is required.');
    expect(spy).not.toHaveBeenCalled();
  });

  it('validates updates on the same rule as creates', async () => {
    const store = createCrudStore<Row>('Rows', events, {
      validate: (draft) => {
        if (!draft.label) throw new Error('A label is required.');
      }
    });
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true as any);

    await expect(store.update({ id: 1, label: '' })).rejects.toThrow('A label is required.');
    expect(spy).not.toHaveBeenCalled();
  });

  it('empties the list rather than trusting a reply of the wrong shape', async () => {
    const store = createCrudStore<Row>('Rows', events);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ error: 'nope' } as any);

    await store.load();

    expect(get(store)).toEqual([]);
    expect(error).toHaveBeenCalled();
  });

  it('lets a failed write reach the caller, and does not touch the list', async () => {
    // Writes pass no `defaultValue`, so `fetchNui` throws. A store that swallowed it
    // would leave the UI showing a row the server refused to create.
    const store = createCrudStore<Row>('Rows', events);
    vi.spyOn(fetchNuiModule, 'fetchNui').mockRejectedValue(new Error('Player not authenticated'));

    await expect(store.add({ label: 'x' } as any)).rejects.toThrow('Player not authenticated');
    expect(get(store)).toEqual([]);
  });

  it('says which write it has no event for, instead of calling undefined', async () => {
    const readOnly = createCrudStore<Row>('Rows', { list: 'getRows' });
    await expect(readOnly.add({ label: 'x' } as any)).rejects.toThrow(
      'The Rows store has no create event.'
    );
  });

  it('deletes by id and patches in place', async () => {
    const store = createCrudStore<Row>('Rows', events);
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui');
    spy.mockResolvedValue([
      { id: 1, label: 'a' },
      { id: 2, label: 'b' }
    ] as any);
    await store.load();

    store.patch(2, { label: 'B' });
    expect(get(store)).toEqual([
      { id: 1, label: 'a' },
      { id: 2, label: 'B' }
    ]);

    spy.mockResolvedValue(true as any);
    await store.delete(1);
    expect(get(store)).toEqual([{ id: 2, label: 'B' }]);
  });

  it('keeps the existing list when a background refresh fails', async () => {
    // fetchNui's real contract: throw when no `defaultValue` was given, return the
    // default when one was — a store that still passes `defaultValue: []` for reads
    // gets a silent empty reply here, exactly as it would in production from a
    // transport failure or a 15s ServiceProxy timeout.
    const store = createCrudStore<Row>('Rows', events);
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui');

    spy.mockResolvedValueOnce([{ id: 1, label: 'a' }] as any);
    await store.load();
    expect(get(store)).toEqual([{ id: 1, label: 'a' }]);

    spy.mockImplementationOnce(async (_event, _payload, opts) => {
      if (opts && 'defaultValue' in opts) return opts.defaultValue;
      throw new Error('Request timed out');
    });
    await store.load();

    expect(get(store)).toEqual([{ id: 1, label: 'a' }]);
    expect(get(store.loaded)).toBe(true);
  });

  it('sorts rows that have no timestamp without throwing them away', async () => {
    const store = createCrudStore<Row>('Rows', events, { sort: byNewest<Row>('created_at') });
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue([
      { id: 1, label: 'undated' },
      { id: 2, label: 'dated', created_at: '2026-06-01T00:00:00Z' }
    ] as any);

    await store.load();
    expect(get(store).map((r) => r.id)).toEqual([2, 1]);
  });
});
