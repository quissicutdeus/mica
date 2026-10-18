// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get, writable } from 'svelte/store';
import type {
  DirectMessage,
  DirectMessageThread,
  SparkCard,
  SparkMatch,
  SparkProfile,
  SparkVerdict
} from '@mica/shared/types';
import { createPagedStore, useDirectMessages, useService } from '@mica/sdk';

/**
 * Spark's data layer (MICA-255), inside the app, for Glimpse's reason: an add-on cannot put a
 * store in core or a hook in the SDK, so everything it holds lives in its own module.
 *
 * The profile, deck and matches go through `useService('spark')`, untyped, because the contract
 * lives beside its `defineService` in `server/services/Spark.ts` — an add-on's id may not be
 * named in `shared/`. Messages are the shared `dms` service: the inbox's last lines through
 * `useDirectMessages` here, the thread itself through the SDK's `DmThread`, both acting as the
 * one Spark account the player holds (`profile.account_id`), with the match's account as the
 * peer: the server's 'spark' policy serves a thread only while the two are matched.
 *
 * Nothing here holds who liked whom. The server never says, and the first like answers
 * `{ match: null }` exactly as a pass does.
 */

// Resolved per call: a handle captured at module scope closes over the transport as it was at
// import time.
const spark = () => useService('spark');
const dms = () => useDirectMessages('spark');

/** `mica_spark` column limits, mirrored so a field cannot accept what the write refuses. */
export const LIMITS = {
  name: 32,
  bio: 300,
  lookingFor: 60,
  minAge: 18,
  maxAge: 99,
  minPhotos: 1,
  maxPhotos: 4,
  /** `mica_blabber_dms.body`, a varchar(500). */
  message: 500
} as const;

/** Fewer than this many cards left in hand asks the server for the next page. */
export const DECK_REFILL_AT = 3;

export interface SparkProfileInput {
  display_name: string;
  age: number;
  bio: string | null;
  looking_for: string | null;
  photos: { photo_id: number }[];
}

/** My profile, or null before opt-in and after a delete. */
export const profile = writable<SparkProfile | null>(null);
export const profileLoaded = writable(false);

/**
 * Read my profile. Never rejects: it runs from `onAppForeground`. A failure keeps what was
 * held, so one failed read never sends a player with a profile back to the editor.
 */
export const loadProfile = async (): Promise<void> => {
  try {
    profile.set(await spark().call<SparkProfile | null>('mine', {}));
    profileLoaded.set(true);
  } catch (error) {
    console.warn('micaOS Spark: could not load your profile', error);
  }
};

/** Opt in, or edit. One action for both; the server writes the name to the Spark account. */
export const saveProfile = async (input: SparkProfileInput): Promise<SparkProfile> => {
  const saved = await spark().call<SparkProfile>('save', input);
  profile.set(saved);
  return saved;
};

/** Delete the profile, every swipe, match and thread. The deck forgets it at once. */
export const removeProfile = async (): Promise<void> => {
  const removed = await spark().call<boolean>('remove', {});
  if (removed === false) throw new Error('There is no profile to delete.');
  profile.set(null);
  matches.set([]);
  threads.set([]);
};

/** The deck: one card at a time on screen, a page of them in hand. */
export const deck = createPagedStore<SparkCard>('deck', { pageSize: 10, service: 'spark' });

export const loadDeck = (): Promise<void> => deck.load();

/** Ask for the next page once fewer than `DECK_REFILL_AT` cards remain. */
export const refillDeck = async (): Promise<void> => {
  if (get(deck).length < DECK_REFILL_AT && get(deck.hasMore)) await deck.loadMore();
};

/** Every mutual like, newest first. */
export const matches = writable<SparkMatch[]>([]);
export const matchesLoaded = writable(false);

/** Never rejects; a failed read keeps the last list. */
export const loadMatches = async (): Promise<void> => {
  try {
    matches.set(await spark().call<SparkMatch[]>('matches', {}));
    matchesLoaded.set(true);
  } catch (error) {
    console.warn('micaOS Spark: could not load your matches', error);
  }
};

/** Put a match at the head, or replace the one already held with the same id. */
const keepMatch = (match: SparkMatch) =>
  matches.update((current) => [match, ...current.filter((m) => m.id !== match.id)]);

const dropMatch = (matchId: number) =>
  matches.update((current) => current.filter((m) => m.id !== matchId));

/**
 * Like or pass. The card leaves the deck either way; a match comes back only on the second
 * like, and then it is in the matches list before the caller shows anything.
 */
export const swipe = async (card: SparkCard, verdict: SparkVerdict): Promise<SparkMatch | null> => {
  const reply = await spark().call<{ match: SparkMatch | null }>('swipe', {
    profile_id: card.id,
    verdict
  });
  deck.remove(card.id);
  void refillDeck();
  if (reply.match) {
    keepMatch(reply.match);
    void loadThreads();
  }
  return reply.match;
};

export const unmatch = async (match: SparkMatch): Promise<void> => {
  const ok = await spark().call<boolean>('unmatch', { match_id: match.id });
  if (ok === false) throw new Error('That match is already gone.');
  dropMatch(match.id);
};

/** Block the account behind a profile: unmatched, and gone from the deck for good. */
export const block = async (card: SparkCard): Promise<void> => {
  await spark().call<boolean>('block', { profile_id: card.id });
  matches.update((current) => current.filter((m) => m.profile.id !== card.id));
  deck.remove(card.id);
};

/**
 * A push from the server: the other side unmatched, blocked or deleted their profile. An open
 * thread with them closes because its match is gone from the list, which the app watches.
 */
export const receiveUnmatched = (matchId: number): void => dropMatch(matchId);

/** Last message and unread count per correspondent, merged into the matches by account. */
export const threads = writable<DirectMessageThread[]>([]);

/** Never rejects: `useDirectMessages().threads()` answers `[]` on failure. */
export const loadThreads = async (): Promise<void> => {
  threads.set(await dms().threads());
};

export interface InboxRow {
  match: SparkMatch;
  last: DirectMessage | null;
  unread: number;
}

const stamp = (row: InboxRow) => new Date(row.last?.created_at ?? row.match.created_at).getTime();

/** The matches list: each match with its thread's last line, most recent activity first. */
export const inbox = derived([matches, threads], ([list, rows]): InboxRow[] =>
  list
    .map((match) => {
      const thread = rows.find((t) => t.peer_account_id === match.profile.account_id);
      return { match, last: thread?.last ?? null, unread: thread?.unread ?? 0 };
    })
    .sort((a, b) => stamp(b) - stamp(a))
);

export const unreadTotal = derived(threads, (rows) =>
  rows.reduce((total, row) => total + row.unread, 0)
);
