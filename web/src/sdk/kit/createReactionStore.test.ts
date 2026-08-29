import { describe, it, expect, vi } from 'vitest';
import { get } from 'svelte/store';
import { createReactionStore, NO_REACTIONS, type ReactionTransport } from './createReactionStore';
import type { ReactionSummary } from '@shared/types';

const summary = (counts: Record<string, number>, mine: string[] = []): ReactionSummary => ({
  counts,
  mine
});

/** A transport that records what it was asked and answers with whatever the test set up. */
const stub = (over: Partial<ReactionTransport> = {}) => {
  const transport = {
    load: vi.fn(async (): Promise<Record<number, ReactionSummary>> => ({})),
    react: vi.fn(async () => undefined),
    unreact: vi.fn(async () => undefined),
    ...over
  };
  return { transport, store: createReactionStore(transport) };
};

/**
 * The reactions primitive (MICA-98).
 *
 * These pin the four things that were duplicated inside Blabber and would have been
 * duplicated again by Messages: the batched read, the optimistic paint, the rollback on a
 * refused write, and the fact that taking a reaction back removes the chip rather than
 * leaving a zero behind.
 */
describe('createReactionStore', () => {
  describe('load', () => {
    it('merges a batched read, keyed by target id', async () => {
      const { transport, store } = stub({
        load: vi.fn(async () => ({ 7: summary({ '👍': 2 }, ['👍']) }))
      });

      await store.load([7, 8]);

      // One call for the page, not one per target — the whole reason the read is batched.
      expect(transport.load).toHaveBeenCalledTimes(1);
      expect(transport.load).toHaveBeenCalledWith([7, 8]);
      expect(get(store)[7]).toEqual(summary({ '👍': 2 }, ['👍']));
      // A target the server said nothing about stays absent rather than becoming empty.
      expect(get(store)[8]).toBeUndefined();
    });

    it('keeps targets an earlier page loaded', async () => {
      // A thread scrolled upward reads older messages as a second page. Replacing the map
      // instead of merging would blank the reactions still on screen above.
      const { store } = stub({
        load: vi.fn(async (ids: number[]) => ({ [ids[0]]: summary({ '🔥': 1 }) }))
      });

      await store.load([1]);
      await store.load([2]);

      expect(Object.keys(get(store)).sort()).toEqual(['1', '2']);
    });

    it('does not reach the server for an empty page', async () => {
      const { transport, store } = stub();
      await store.load([]);
      expect(transport.load).not.toHaveBeenCalled();
    });
  });

  describe('toggle', () => {
    it('paints the reaction before the write resolves', async () => {
      let release!: () => void;
      const { store } = stub({
        react: vi.fn(
          () => new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
        )
      });

      const pending = store.toggle(5, '👍');

      // The point of an optimistic update: the chip is there while the round trip is still
      // in flight, not after it.
      expect(get(store)[5]).toEqual(summary({ '👍': 1 }, ['👍']));
      release();
      await pending;
      expect(get(store)[5]).toEqual(summary({ '👍': 1 }, ['👍']));
    });

    it('adds to a count somebody else already started', async () => {
      const { store } = stub({ load: vi.fn(async () => ({ 5: summary({ '👍': 3 }) })) });
      await store.load([5]);

      await store.toggle(5, '👍');

      expect(get(store)[5]).toEqual(summary({ '👍': 4 }, ['👍']));
    });

    it('takes it back, and drops the chip rather than leaving a zero', async () => {
      const { transport, store } = stub({
        load: vi.fn(async () => ({ 5: summary({ '👍': 1, '🔥': 2 }, ['👍']) }))
      });
      await store.load([5]);

      await store.toggle(5, '👍');

      expect(transport.unreact).toHaveBeenCalledWith(5, '👍');
      expect(transport.react).not.toHaveBeenCalled();
      // `👍` is gone entirely — a `0` entry is a chip every renderer has to remember to filter.
      expect(get(store)[5]).toEqual(summary({ '🔥': 2 }, []));
    });

    it('leaves a reaction somebody else still holds at their count', async () => {
      const { store } = stub({ load: vi.fn(async () => ({ 5: summary({ '👍': 3 }, ['👍']) })) });
      await store.load([5]);

      await store.toggle(5, '👍');

      expect(get(store)[5]).toEqual(summary({ '👍': 2 }, []));
    });

    it('refetches and rethrows when the write is refused', async () => {
      const boom = new Error('Claim a handle first.');
      const load = vi.fn(async () => ({ 5: summary({ '👍': 9 }, []) }));
      const { transport, store } = stub({
        load,
        react: vi.fn(async () => {
          throw boom;
        })
      });

      await expect(store.toggle(5, '👍')).rejects.toThrow('Claim a handle first.');

      // Reconciled from the server, not by undoing the arithmetic — and only the one target.
      expect(transport.load).toHaveBeenCalledWith([5]);
      expect(get(store)[5]).toEqual(summary({ '👍': 9 }, []));
    });

    it('rethrows so the caller can toast, rather than swallowing the failure', async () => {
      const { store } = stub({
        react: vi.fn(async () => {
          throw new Error('nope');
        })
      });
      await expect(store.toggle(1, '👍')).rejects.toThrow('nope');
    });
  });

  it('exposes no setter — every write goes through load or toggle', () => {
    const { store } = stub();
    expect('set' in store).toBe(false);
    expect('update' in store).toBe(false);
  });

  it('NO_REACTIONS is the empty shape, and is frozen', () => {
    expect(NO_REACTIONS).toEqual({ counts: {}, mine: [] });
    expect(Object.isFrozen(NO_REACTIONS)).toBe(true);
  });
});
