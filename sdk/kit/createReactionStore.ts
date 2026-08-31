import { writable, type Readable } from 'svelte/store';
import type { ReactionSummary } from '@gphone/shared/types';

/**
 * What a target with nothing on it looks like.
 *
 * Exported because a caller reading the map directly (`$reactions[id]`) gets `undefined` for a
 * target no load has covered yet, and every call site would otherwise write its own
 * `?? { counts: {}, mine: [] }`. `ReactionBar` defaults to this, so a component that hands the
 * bar a raw lookup does not have to.
 */
export const NO_REACTIONS: ReactionSummary = Object.freeze({ counts: {}, mine: [] });

/**
 * How one app's reactions actually reach its server. Supplied by the app; the store never
 * names a route, a table, or an identity of its own.
 *
 * That split is the whole point. Blabber reacts to `gphone_blabber_dms` as an *account*
 * through the shared `accounts` facet; a future consumer may react to its own rows as a
 * citizenid through a service of its own. Neither of those is a property of "a reaction" —
 * the batched read, the optimistic toggle and the rollback are, and this file owns exactly
 * those.
 *
 * `react`/`unreact` are two members rather than one `toggle(targetId, emoji, on)`, so an app
 * writes two literal facet calls. A computed action name is invisible to
 * `server/__tests__/routes.test.ts`, which cross-references every layer by scanning for
 * literals — and a route it cannot see is reported as dead weight.
 */
export interface ReactionTransport {
  /**
   * One read for a page of targets, not one per target. Thirty rows asking individually is
   * ninety round trips through NUI, which is the thing the batched shape exists to avoid.
   *
   * A target absent from the reply is a target with no reactions; it does not have to be
   * echoed back as an empty summary. That is a promise about the *transport* only — the store
   * fills the omission in as `NO_REACTIONS` rather than passing it on, so absence never reaches
   * a caller as an answer. `ReactionStore.load` is where that half is written down.
   */
  load: (targetIds: number[]) => Promise<Record<number, ReactionSummary>>;
  /**
   * `Promise<unknown>` rather than `Promise<void>`: these are usually a facet call handed
   * straight through, and a facet answers with whatever the server echoed. Demanding
   * `Promise<void>` would make every app write a `.then(() => {})` to discard a value this
   * store already ignores — the next `load` is what the counts come from, not the echo.
   */
  react: (targetId: number, emoji: string) => Promise<unknown>;
  unreact: (targetId: number, emoji: string) => Promise<unknown>;
}

/**
 * Reaction summaries keyed by target id, plus the two verbs that change them.
 *
 * A `Readable`, not a `Writable`: everything that writes is on this interface, so there is no
 * path by which a component can set a count the server has not agreed to.
 */
export interface ReactionStore extends Readable<Record<number, ReactionSummary>> {
  /**
   * Read these targets and merge the answer into the map. A no-op for an empty list.
   *
   * **Every id asked about is present when this resolves**, as `NO_REACTIONS` if the reply did
   * not mention it — the transport may omit an empty summary, this may not. Ids nobody asked
   * about are left alone, which is what makes a second page merge rather than replace.
   *
   * The invariant is load-bearing, not tidiness. Without it `undefined` means both "never
   * asked" and "asked, and it has nothing", a target whose last reaction was removed keeps its
   * chips forever, and `toggle` cannot roll back — merging a reply that omits the target leaves
   * the entry optimism just painted exactly where it was.
   */
  load: (targetIds: number[]) => Promise<void>;
  /**
   * Add the caller's reaction, or take it back if it is already theirs. Optimistic, then
   * reconciled: a failed write refetches the one target and rethrows, so the caller can toast.
   * The optimistic entry does not outlive a refused write, whatever the refetch answers.
   */
  toggle: (targetId: number, emoji: string) => Promise<void>;
}

/**
 * The reactions primitive (MICA-98): one keyed cache, one batched read, one optimistic
 * toggle, for every surface that lets a player react to something.
 *
 * Blabber's DMs had all of this written out inside the app — a `writable` map, an empty
 * constant, a batched loader and a toggle whose optimism and rollback are the fiddly part.
 * Messages wants the same behaviour (MICA-68) and Blabs themselves plausibly will, and
 * three copies of an optimistic update is three places for one of them to forget the
 * rollback. An optimistic update that survives a refused write is a lie the UI tells.
 *
 * Kept out of the map rather than merged onto the rows it describes, mirroring Blabber's
 * `engagement`: a reaction landing must not replace a row object and cost it its identity in
 * a keyed `{#each}`.
 *
 * ```ts
 * export const dmReactions = createReactionStore({
 *   load: (ids) => accounts().getReactionsFor({ app, target_table, target_ids: ids }),
 *   react: (id, emoji) => accounts().reactToTarget(payload(id, emoji)),
 *   unreact: (id, emoji) => accounts().unreactToTarget(payload(id, emoji))
 * });
 * ```
 *
 * It lives in `kit/` and not `services/` deliberately: it names no route and touches no
 * shell, so it bundles into a sandboxed add-on unchanged — which matters, because Blabber
 * is one (`core: false`).
 */
export function createReactionStore(transport: ReactionTransport): ReactionStore {
  const summaries = writable<Record<number, ReactionSummary>>({});

  /** Every id in `targetIds`, gone from the map — the state before anything was known. */
  const forget = (
    current: Record<number, ReactionSummary>,
    targetIds: number[]
  ): Record<number, ReactionSummary> => {
    const next = { ...current };
    for (const id of targetIds) delete next[id];
    return next;
  };

  const load = async (targetIds: number[]): Promise<void> => {
    if (targetIds.length === 0) return;
    const reply = await transport.load(targetIds);
    summaries.update((current) => {
      // Forgotten first, so what the map last said about a requested target cannot outlive a
      // reply that no longer mentions it, then answered for everything that was asked about.
      // An omitted target has no reactions, and saying so is what lets a stale count go and a
      // rollback land; see `ReactionStore.load`.
      const next = { ...forget(current, targetIds), ...reply };
      for (const id of targetIds) next[id] ??= NO_REACTIONS;
      return next;
    });
  };

  const toggle = async (targetId: number, emoji: string): Promise<void> => {
    let hadIt = false;

    summaries.update((current) => {
      const existing = current[targetId] ?? NO_REACTIONS;
      hadIt = existing.mine.includes(emoji);

      const counts = { ...existing.counts };
      const next = (counts[emoji] ?? 0) + (hadIt ? -1 : 1);
      // Dropped rather than left at zero. A `0` entry is a chip the bar has to remember to
      // filter out, and the count is not authoritative here anyway — the next read is.
      if (next > 0) counts[emoji] = next;
      else delete counts[emoji];

      return {
        ...current,
        [targetId]: {
          counts,
          mine: hadIt ? existing.mine.filter((e) => e !== emoji) : [...existing.mine, emoji]
        }
      };
    });

    try {
      if (hadIt) await transport.unreact(targetId, emoji);
      else await transport.react(targetId, emoji);
    } catch (error) {
      // Put it back, from the server rather than by undoing the arithmetic — a second tap
      // may have landed in between, and re-inverting would then be wrong twice. `load` answers
      // for every id it was given, so a refetch that omits this target resets it to
      // `NO_REACTIONS` instead of leaving the optimistic entry standing.
      //
      // Dropped first all the same, because a refetch is not guaranteed to answer at all: a
      // transport that throws would otherwise let the chip outlive the write it was painted
      // for, which is the one thing this store exists to prevent. The refused write stays the
      // error the caller toasts — a failed refetch must not take its place.
      summaries.update((current) => forget(current, [targetId]));
      try {
        await load([targetId]);
      } catch {
        // Deliberately swallowed; the write's error is thrown below.
      }
      throw error;
    }
  };

  return { subscribe: summaries.subscribe, load, toggle };
}
