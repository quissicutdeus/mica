// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SparkCard, SparkMatch, SparkProfile } from '@mica/shared/types';
import type { MockHandler } from '../registry';
import { mockAccounts, mockOwnedAccountIds } from '../social';
import {
  PASS_TTL_MS,
  SPARK_GONE,
  SPARK_ME,
  blockedEitherWay,
  dropThread,
  galleryPhoto,
  liveProfileOf,
  matchBetween,
  mockSparkBlocks,
  mockSparkMatches,
  mockSparkProfiles,
  mockSparkSwipes,
  newSparkMatchId,
  newSparkProfileId,
  seedOpener,
  toCard,
  toMatch,
  toProfile
} from '../spark';

/** `DECK_PAGING` in `server/services/Spark.ts`: a limit past the cap is clamped, not refused. */
const DECK_PAGE = 10;
const DECK_MAX = 20;

/** The caller's Spark account. The server makes it on first save; the mock seeds it. */
const myAccount = (): number => SPARK_ME;

/** My live profile, or the refusal every action past opt-in answers without one. */
const requireMine = () => {
  const mine = liveProfileOf(myAccount());
  if (!mine) throw new Error('Make a profile first.');
  return mine;
};

/**
 * Another live profile I may act on: not mine, not deleted, no block either way. Every miss is
 * the same sentence, so a refusal says nothing about which of those it was.
 */
const reachable = (profileId: unknown) => {
  const me = myAccount();
  const target = mockSparkProfiles.find((p) => p.id === profileId && p.status === 'active');
  if (!target || target.account_id === me || blockedEitherWay(me, target.account_id)) {
    throw new Error(SPARK_GONE);
  }
  return target;
};

const text = (value: unknown, max: number, what: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) {
    throw new Error(`Keep the ${what} to ${max} characters.`);
  }
  return value.trim() || null;
};

/** The swipe I hold on someone, with a pass past its 14 days treated as never given. */
const liveSwipe = (from: number, to: number) =>
  mockSparkSwipes.find(
    (s) =>
      s.from_account === from &&
      s.to_account === to &&
      (s.verdict === 'like' || Date.now() - s.at < PASS_TTL_MS)
  );

const unmatch = (matchId: number) => {
  const index = mockSparkMatches.findIndex((m) => m.id === matchId);
  if (index === -1) return;
  const [match] = mockSparkMatches.splice(index, 1);
  dropThread(match.a, match.b);
};

/**
 * Spark's server, in the browser (MICA-255). Every action the contract in
 * `server/services/Spark.ts` declares, answering its shape, with its refusals.
 */
export const mocks: Record<string, MockHandler> = {
  'spark:mine': (): SparkProfile | null => {
    const mine = liveProfileOf(myAccount());
    return mine ? toProfile(mine) : null;
  },
  'spark:save': ({
    display_name,
    age,
    bio,
    looking_for,
    photos
  }: {
    display_name: string;
    age: number;
    bio?: string | null;
    looking_for?: string | null;
    photos: { photo_id: number }[];
  }): SparkProfile => {
    const name = typeof display_name === 'string' ? display_name.trim() : '';
    if (name.length < 1 || name.length > 32) throw new Error('Pick a name of 1–32 characters.');
    if (!Number.isInteger(age) || age < 18 || age > 99) {
      throw new Error('Age must be between 18 and 99.');
    }
    if (!Array.isArray(photos) || photos.length < 1 || photos.length > 4) {
      throw new Error('Pick one to four photos.');
    }
    const photoIds = photos.map((p) => p.photo_id);
    if (new Set(photoIds).size !== photoIds.length || photoIds.some((id) => !galleryPhoto(id))) {
      throw new Error('Pick photos from your own gallery.');
    }
    const me = myAccount();
    // The account is the server's to make; the display name is written to it.
    mockOwnedAccountIds.add(me);
    const account = mockAccounts.find((a) => a.id === me);
    if (account) account.display_name = name;

    const fields = {
      age,
      bio: text(bio, 300, 'bio'),
      looking_for: text(looking_for, 60, 'looking for line'),
      photo_ids: photoIds
    };
    const existing = liveProfileOf(me);
    if (existing) {
      Object.assign(existing, fields);
      return toProfile(existing);
    }
    const created = {
      id: newSparkProfileId(),
      account_id: me,
      status: 'active' as const,
      ...fields
    };
    mockSparkProfiles.push(created);
    return toProfile(created);
  },
  'spark:remove': (): boolean => {
    const me = myAccount();
    const mine = liveProfileOf(me);
    if (!mine) return false;
    mine.status = 'deleted';
    for (let i = mockSparkSwipes.length - 1; i >= 0; i--) {
      const s = mockSparkSwipes[i];
      if (s.from_account === me || s.to_account === me) mockSparkSwipes.splice(i, 1);
    }
    // Ids first: `unmatch` splices the table, so it cannot be walked while that happens.
    const matchIds = mockSparkMatches.filter((m) => m.a === me || m.b === me).map((m) => m.id);
    for (const id of matchIds) unmatch(id);
    return true;
  },
  'spark:deck': ({ cursor, limit }: { cursor?: number | null; limit?: number } = {}) => {
    const me = requireMine().account_id;
    const size =
      typeof limit === 'number' && Number.isInteger(limit) && limit > 0
        ? Math.min(limit, DECK_MAX)
        : DECK_PAGE;
    const eligible = mockSparkProfiles
      .filter(
        (p) =>
          p.status === 'active' &&
          p.account_id !== me &&
          !blockedEitherWay(me, p.account_id) &&
          !liveSwipe(me, p.account_id) &&
          (cursor == null || p.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const rows: SparkCard[] = eligible.slice(0, size).map(toCard);
    const nextCursor = eligible.length > rows.length ? rows[rows.length - 1].id : null;
    return { rows, nextCursor };
  },
  'spark:swipe': ({
    profile_id,
    verdict
  }: {
    profile_id: number;
    verdict: 'like' | 'pass';
  }): { match: SparkMatch | null } => {
    if (verdict !== 'like' && verdict !== 'pass') throw new Error('Like or pass.');
    const me = requireMine().account_id;
    const target = reachable(profile_id);
    const peer = target.account_id;
    const prior = mockSparkSwipes.findIndex((s) => s.from_account === me && s.to_account === peer);
    if (prior !== -1) mockSparkSwipes.splice(prior, 1);
    mockSparkSwipes.push({ from_account: me, to_account: peer, verdict, at: Date.now() });
    // The first like says nothing to either side; only the second one reveals the match.
    if (verdict === 'pass' || liveSwipe(peer, me)?.verdict !== 'like') return { match: null };
    const existing = matchBetween(me, peer);
    if (existing) return { match: toMatch(existing, me) };
    const created = {
      id: newSparkMatchId(),
      a: peer,
      b: me,
      created_at: new Date().toISOString()
    };
    mockSparkMatches.push(created);
    seedOpener(peer, me);
    return { match: toMatch(created, me) };
  },
  'spark:matches': (): SparkMatch[] => {
    const me = myAccount();
    if (!liveProfileOf(me)) return [];
    return mockSparkMatches
      .filter((m) => m.a === me || m.b === me)
      .sort((x, y) => y.id - x.id)
      .map((m) => toMatch(m, me))
      .filter((m): m is SparkMatch => m !== null);
  },
  'spark:unmatch': ({ match_id }: { match_id: number }): boolean => {
    const me = myAccount();
    const match = mockSparkMatches.find((m) => m.id === match_id && (m.a === me || m.b === me));
    if (!match) return false;
    unmatch(match.id);
    return true;
  },
  'spark:block': ({ profile_id }: { profile_id: number }): boolean => {
    const me = requireMine().account_id;
    const target = reachable(profile_id);
    mockSparkBlocks.push({ blocker: me, blocked: target.account_id });
    const match = matchBetween(me, target.account_id);
    if (match) unmatch(match.id);
    return true;
  }
};
