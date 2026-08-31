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
      // A target the server said nothing about was still asked about, so it is answered: the
      // transport may omit an empty summary, the store may not. `undefined` has to keep meaning
      // "no load has covered this yet" and nothing else.
      expect(get(store)[8]).toEqual(NO_REACTIONS);
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

    it('answers for every target it asked about, and clears one that has emptied out', async () => {
      // The invariant the rollback rests on. A reply that omits a *requested* target says that
      // target has nothing on it, so whatever the map last held for it is stale and goes —
      // otherwise a chip nobody holds any more stays painted, and `toggle` has no way to tell
      // its own optimistic entry from the truth.
      let reply: Record<number, ReactionSummary> = { 5: summary({ '👍': 1 }, ['👍']) };
      const { store } = stub({ load: vi.fn(async () => reply) });

      await store.load([5]);
      expect(get(store)[5]).toEqual(summary({ '👍': 1 }, ['👍']));

      reply = {};
      await store.load([5]);

      expect(get(store)[5]).toEqual(NO_REACTIONS);
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

    it('rethrows so the caller can toast, and leaves no chip behind when it does', async () => {
      // The default stub answers the refetch with `{}` — a transport exercising the documented
      // permission to omit a target with no reactions, which is exactly what a target whose only
      // write was just refused looks like. Asserting the throw alone passed while the optimistic
      // entry survived the rollback that was supposed to remove it.
      const { store } = stub({
        react: vi.fn(async () => {
          throw new Error('nope');
        })
      });

      await expect(store.toggle(1, '👍')).rejects.toThrow('nope');

      // The refetch answered — "nothing on this target" — so the entry is the empty summary,
      // not the reaction that was refused.
      expect(get(store)[1]).toEqual(NO_REACTIONS);
    });

    it('drops the optimistic chip even when the refetch fails too', async () => {
      // The rollback cannot be conditional on the refetch answering. Blabber's `getReactionsFor`
      // is a `fetchNui` with a default and never throws, but the store may not lean on that —
      // the transport is the app's to write. The refused write stays the error the caller toasts.
      const { store } = stub({
        load: vi.fn(async () => {
          throw new Error('the refetch is out too');
        }),
        react: vi.fn(async () => {
          throw new Error('nope');
        })
      });

      await expect(store.toggle(1, '👍')).rejects.toThrow('nope');

      // Nothing answered, so the map claims nothing about this target rather than claiming it
      // is empty. Either way the chip optimism painted is gone.
      expect(get(store)[1]).toBeUndefined();
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
