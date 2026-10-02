// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { createCrudStore, byNewest } from './createCrudStore';
/**
 * MICA-172: the stub point is `sdk/nui/transport`, not `nui/fetchNui`.
 *
 * The code under test reaches the transport through the SDK's seam now, so spying on the
 * phone's own `fetchNui` module replaces a binding nothing calls — the real transport runs
 * and the failure reads as fixture trouble rather than as a stub that never applied. Stub
 * the seam and both sides of it are covered.
 */
import * as fetchNuiModule from './nui/transport';

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
    ]);

    return store.load().then(async () => {
      expect(get(store).map((r) => r.id)).toEqual([2, 1]);

      spy.mockResolvedValue({ id: 3, label: 'newest', created_at: '2026-09-01T00:00:00Z' });
      await store.add({ label: 'newest' });
      expect(get(store).map((r) => r.id)).toEqual([3, 2, 1]);

      // And an edit that changes the sort key moves the row, rather than leaving it
      // where it happened to be.
      spy.mockResolvedValue(true);
      await store.update({ id: 1, label: 'old', created_at: '2026-12-01T00:00:00Z' });
      expect(get(store).map((r) => r.id)).toEqual([1, 3, 2]);
    });
  });

  it('leaves the server order alone when no comparator is given', async () => {
    const store = createCrudStore<Row>('Rows', events);
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue([
      { id: 9, label: 'b' },
      { id: 4, label: 'a' }
    ]);

    await store.load();
    expect(get(store).map((r) => r.id)).toEqual([9, 4]);
  });

  it('refuses an invalid write before it reaches the server', async () => {
    const store = createCrudStore<Row>('Rows', events, {
      validate: (draft) => {
        if (!draft.label) throw new Error('A label is required.');
      }
    });
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({});

    await expect(store.add({} as any)).rejects.toThrow('A label is required.');
    expect(spy).not.toHaveBeenCalled();
  });

  it('validates updates on the same rule as creates', async () => {
    const store = createCrudStore<Row>('Rows', events, {
      validate: (draft) => {
        if (!draft.label) throw new Error('A label is required.');
      }
    });
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true);

    await expect(store.update({ id: 1, label: '' })).rejects.toThrow('A label is required.');
    expect(spy).not.toHaveBeenCalled();
  });

  it('empties the list rather than trusting a reply of the wrong shape', async () => {
    const store = createCrudStore<Row>('Rows', events);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ error: 'nope' });

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
    ]);
    await store.load();

    store.patch(2, { label: 'B' });
    expect(get(store)).toEqual([
      { id: 1, label: 'a' },
      { id: 2, label: 'B' }
    ]);

    spy.mockResolvedValue(true);
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

    spy.mockResolvedValueOnce([{ id: 1, label: 'a' }]);
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

  it('MICA-119: does not duplicate a created row that a racing load already pulled in', async () => {
    // The create round trip and a `load()` triggered elsewhere (foreground, another
    // caller) are independent — if the load's reply lands, and already contains the row
    // the server just created, before `add`'s own `mutate` runs, appending unconditionally
    // would show the row twice.
    const store = createCrudStore<Row>('Rows', events);
    let resolveCreate!: (row: Row) => void;
    const createReply = new Promise<Row>((resolve) => {
      resolveCreate = resolve;
    });

    vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(async (action: string) => {
      if (action === events.create) return createReply;
      if (action === events.list) return [{ id: 5, label: 'x' }];
      throw new Error(`unexpected action ${action}`);
    });

    const addPromise = store.add({ label: 'x' });

    // The racing load lands first and already carries the new row.
    await store.load();
    expect(get(store)).toEqual([{ id: 5, label: 'x' }]);

    // Now the create this store's own `add` was waiting on resolves.
    resolveCreate({ id: 5, label: 'x' });
    await addPromise;

    expect(get(store)).toEqual([{ id: 5, label: 'x' }]);
  });

  it('sorts rows that have no timestamp without throwing them away', async () => {
    const store = createCrudStore<Row>('Rows', events, { sort: byNewest<Row>('created_at') });
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue([
      { id: 1, label: 'undated' },
      { id: 2, label: 'dated', created_at: '2026-06-01T00:00:00Z' }
    ]);

    await store.load();
    expect(get(store).map((r) => r.id)).toEqual([2, 1]);
  });
});

/**
 * Every write used to re-sort the whole list. These pin that dropping the sort changed the
 * cost and nothing else: the order after any sequence of writes is the order the old
 * full-sort code gave, ties included.
 */
describe('createCrudStore ordering without a full sort per write', () => {
  type Ranked = { id: number; label: string; rank: number; created_at?: string };

  /** mulberry32 — a fixed seed makes a failing sequence replayable. */
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** The pre-change write paths, verbatim, as the reference model. */
  const reference = (sort: (a: Ranked, b: Ranked) => number) => {
    const ordered = (rows: Ranked[]) => [...rows].sort(sort);
    return {
      add: (rows: Ranked[], created: Ranked) =>
        ordered(
          rows.some((r) => r.id === created.id)
            ? rows.map((r) => (r.id === created.id ? created : r))
            : [...rows, created]
        ),
      update: (rows: Ranked[], row: Ranked) =>
        ordered(rows.map((r) => (r.id === row.id ? row : r))),
      patch: (rows: Ranked[], id: number, changes: Partial<Ranked>) =>
        ordered(rows.map((r) => (r.id === id ? { ...r, ...changes } : r))),
      set: ordered
    };
  };

  // A small pool, so ties are the common case rather than the exception — and an undated
  // row and an unparseable one, both of which `byNewest` floors at the epoch.
  const DATES = [
    undefined,
    'not a date',
    '2026-01-01T00:00:00Z',
    '2026-03-01T00:00:00Z',
    '2026-06-01T00:00:00Z'
  ];

  const comparators: [string, () => (a: Ranked, b: Ranked) => number][] = [
    ['a numeric key with ties', () => (a, b) => a.rank - b.rank],
    ['byNewest over dates with ties', () => byNewest<Ranked>('created_at')]
  ];

  for (const [name, makeSort] of comparators) {
    for (const seed of [1, 7, 42]) {
      it(`matches a fresh full sort after every write — ${name}, seed ${seed}`, async () => {
        const random = prng(seed);
        const pick = <V>(values: readonly V[]): V => values[Math.floor(random() * values.length)];
        const sort = makeSort();
        const model = reference(sort);
        const store = createCrudStore<Ranked>('Rows', events, { sort });

        let created: Ranked | undefined;
        vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(async (action: string) =>
          action === events.create ? created : true
        );

        let seq = 0;
        let nextId = 1;
        const fresh = (id: number): Ranked => ({
          id,
          label: `v${seq++}`,
          rank: Math.floor(random() * 4),
          created_at: pick(DATES)
        });
        const anyId = (rows: Ranked[]) =>
          random() < 0.15 || rows.length === 0 ? 10_000 + nextId : pick(rows).id;

        let expected: Ranked[] = [];
        for (let step = 0; step < 250; step++) {
          const rows = get(store);
          const op = random();
          if (op < 0.3) {
            // Mostly a new row; sometimes one already held (MICA-119's racing load).
            created = fresh(random() < 0.2 && rows.length ? pick(rows).id : nextId++);
            expected = model.add(expected, created);
            await store.add({ label: created.label, rank: created.rank });
          } else if (op < 0.5) {
            const row = fresh(anyId(rows));
            expected = model.update(expected, row);
            await store.update(row);
          } else if (op < 0.75) {
            const id = anyId(rows);
            const changes: Partial<Ranked> =
              random() < 0.3
                ? { label: `p${seq++}` }
                : { rank: Math.floor(random() * 4), created_at: pick(DATES) };
            expected = model.patch(expected, id, changes);
            store.patch(id, changes);
          } else if (op < 0.85 && rows.length) {
            const id = pick(rows).id;
            expected = expected.filter((r) => r.id !== id);
            await store.delete(id);
          } else if (op < 0.92) {
            // Occasionally hold an id twice — the one shape that keeps the full sort.
            const next = [...rows].reverse();
            if (rows.length && random() < 0.3) next.push({ ...pick(rows), label: `d${seq++}` });
            expected = model.set(next);
            store.set(next);
          }
          expect(get(store), `step ${step}`).toEqual(expected);
        }
      });
    }
  }

  const loadedStore = async (n: number) => {
    let calls = 0;
    const store = createCrudStore<Ranked>('Rows', events, {
      sort: (a, b) => {
        calls++;
        return a.rank - b.rank;
      }
    });
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(
      Array.from({ length: n }, (_, i) => ({ id: i + 1, label: `r${i}`, rank: i * 10 }))
    );
    await store.load();
    vi.restoreAllMocks();
    return {
      store,
      calls: () => calls,
      reset: () => {
        calls = 0;
      }
    };
  };

  it('a patch that keeps its position compares against its two neighbours and no more', async () => {
    // The old path re-sorted: on an already-ordered list that is still n − 1 comparisons
    // (TimSort finds the one run), and n·log n once anything is out of place.
    const { store, calls, reset } = await loadedStore(256);
    reset();
    store.patch(128, { label: 'renamed' });
    expect(calls()).toBeLessThanOrEqual(2);
    expect(get(store)[127]).toMatchObject({ id: 128, label: 'renamed' });
  });

  it('a patch that moves the row, and an add, cost a binary search', async () => {
    const { store, calls, reset } = await loadedStore(256);
    const bound = 2 + 2 * Math.ceil(Math.log2(257));

    reset();
    store.patch(10, { rank: 2005 });
    expect(calls()).toBeLessThanOrEqual(bound);
    expect(get(store).findIndex((r) => r.id === 10)).toBe(200);

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ id: 999, label: 'n', rank: 15 });
    reset();
    await store.add({ label: 'n', rank: 15 });
    expect(calls()).toBeLessThanOrEqual(bound);
    expect(get(store)[2]).toMatchObject({ id: 999 });
  });
});

describe('byNewest', () => {
  type Dated = { id: number; at?: string };
  const shuffled = (n: number): Dated[] => {
    const rows = Array.from({ length: n }, (_, i) => ({
      id: i,
      at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()
    }));
    for (let i = n - 1; i > 0; i--) {
      const j = (i * 7919) % (i + 1);
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    return rows;
  };

  it('parses each row once on a full sort, and not again on a re-sort', () => {
    const rows = shuffled(200);
    const parse = vi.spyOn(Date, 'parse');

    const sorted = [...rows].sort(byNewest<Dated>('at'));
    expect(parse.mock.calls.length).toBeLessThanOrEqual(rows.length);
    expect(sorted.map((r) => r.id)).toEqual(rows.map((r) => r.id).sort((a, b) => b - a));

    // What `conversations.ts` does on every live arrival: a new comparator over the same
    // rows with one replaced. Only the replacement is new.
    parse.mockClear();
    const next = sorted.map((r) => (r.id === 5 ? { ...r, at: '2027-01-01T00:00:00Z' } : r));
    const resorted = [...next].sort(byNewest<Dated>('at'));
    expect(parse.mock.calls.length).toBe(1);
    expect(resorted[0].id).toBe(5);
  });

  it('re-parses a row whose field was changed in place, rather than answering stale', () => {
    const a: Dated = { id: 1, at: '2026-01-01T00:00:00Z' };
    const b: Dated = { id: 2, at: '2026-06-01T00:00:00Z' };
    const newest = byNewest<Dated>('at');
    expect([a, b].sort(newest).map((r) => r.id)).toEqual([2, 1]);

    a.at = '2026-12-01T00:00:00Z';
    expect([a, b].sort(newest).map((r) => r.id)).toEqual([1, 2]);
  });
});
