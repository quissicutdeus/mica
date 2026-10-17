// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SparkCard, SparkMatch, SparkPhoto, SparkProfile } from '@mica/shared/types';
import { mockMedia } from './data';
import { mockAccounts, mockDms, nextMockDmId, toMediaPreview } from './social';

/**
 * Spark's tables, in the browser (MICA-255). Shared by `services/spark.ts` and by
 * `services/dms.ts`, whose 'spark' policy serves a thread only between two matched accounts.
 *
 * The seed is what the e2e lane asserts against. The player's Spark account (30, in
 * `social.ts`) exists and has **no profile**, so the app opens on the editor. Three other
 * profiles exist:
 *
 * - **Maya** (profile 3, account 31) has already liked the player, so liking her back is a
 *   match, and the match leaves one message from her in the thread.
 * - **Jordan** (profile 2, account 32) has swiped on nobody: liking him is no match.
 * - **Casey** (profile 1, account 33) is blocked by the player, so never appears in the deck.
 *
 * The deck therefore opens on Maya, then Jordan, then empty.
 */

/** The player's Spark account, the one per citizen the server keeps unlisted. */
export const SPARK_ME = 30;
export const SPARK_SEED = {
  maya: { profile: 3, account: 31 },
  jordan: { profile: 2, account: 32 },
  casey: { profile: 1, account: 33 }
} as const;

/** What Maya says once the match is made: the one seeded message in the thread. */
export const SPARK_OPENER = 'hey! glad you liked me back 😊';

/** The one refusal every unreachable profile answers, so none of them can be told apart. */
export const SPARK_GONE = 'That profile is gone.';

/** A pass is forgotten after this long, and the profile can come round again. */
export const PASS_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface MockSparkProfile {
  id: number;
  account_id: number;
  age: number;
  bio: string | null;
  looking_for: string | null;
  /** The gallery ids behind the photos, in order. */
  photo_ids: number[];
  status: 'active' | 'deleted' | 'moderated';
}

export interface MockSparkSwipe {
  /** By account rather than profile: a like given before you made a profile still counts. */
  from_account: number;
  to_account: number;
  verdict: 'like' | 'pass';
  at: number;
}

export interface MockSparkMatch {
  id: number;
  /** The two accounts, in no particular order. */
  a: number;
  b: number;
  created_at: string;
}

const galleryPhotos = mockMedia.filter((m) => m.kind === 'photo' && m.status === 'active');

/** A live gallery photo, or undefined — the server's own-photo check, less the ownership. */
export const galleryPhoto = (id: number) => galleryPhotos.find((m) => m.id === id);

const photoAt = (n: number) => galleryPhotos[n % galleryPhotos.length].id;

export const mockSparkProfiles: MockSparkProfile[] = [
  {
    id: SPARK_SEED.casey.profile,
    account_id: SPARK_SEED.casey.account,
    age: 27,
    bio: 'Coffee snob, dog person, terrible at parking.',
    looking_for: null,
    photo_ids: [photoAt(0)],
    status: 'active'
  },
  {
    id: SPARK_SEED.jordan.profile,
    account_id: SPARK_SEED.jordan.account,
    age: 31,
    bio: 'Mechanic by day, street racer by… also day.',
    looking_for: 'Someone who can keep up',
    photo_ids: [photoAt(1)],
    status: 'active'
  },
  {
    id: SPARK_SEED.maya.profile,
    account_id: SPARK_SEED.maya.account,
    age: 25,
    bio: 'Sunset drives up the coast and late-night tacos.',
    looking_for: 'Something real',
    photo_ids: [photoAt(2), photoAt(3)],
    status: 'active'
  }
];

export const mockSparkSwipes: MockSparkSwipe[] = [
  {
    from_account: SPARK_SEED.maya.account,
    to_account: SPARK_ME,
    verdict: 'like',
    at: Date.now() - 60 * 60 * 1000
  }
];

export const mockSparkMatches: MockSparkMatch[] = [];

/** Spark's own blocks, account to account. Either direction hides both from each other. */
export const mockSparkBlocks: { blocker: number; blocked: number }[] = [
  { blocker: SPARK_ME, blocked: SPARK_SEED.casey.account }
];

let nextProfileId = 100;
let nextMatchId = 1;
export const newSparkProfileId = (): number => nextProfileId++;
export const newSparkMatchId = (): number => nextMatchId++;

/** Photo rows are their own sequence, never the gallery id (see `SparkPhoto`). */
const photoRowId = (profileId: number, index: number) => profileId * 10 + index + 1;

export const toPhotos = (profile: MockSparkProfile): SparkPhoto[] =>
  profile.photo_ids.flatMap((photoId, index) => {
    const media = galleryPhoto(photoId);
    if (!media) return [];
    const { id: _galleryId, ...rest } = toMediaPreview(media);
    return [{ id: photoRowId(profile.id, index), media: rest }];
  });

const displayName = (accountId: number) =>
  mockAccounts.find((a) => a.id === accountId)?.display_name ?? null;

/** What another player sees: no photo ids, no status, nothing about who swiped. */
export const toCard = (profile: MockSparkProfile): SparkCard => ({
  id: profile.id,
  account_id: profile.account_id,
  display_name: displayName(profile.account_id),
  age: profile.age,
  bio: profile.bio,
  looking_for: profile.looking_for,
  photos: toPhotos(profile)
});

export const toProfile = (profile: MockSparkProfile): SparkProfile => ({
  ...toCard(profile),
  status: profile.status,
  photo_ids: [...profile.photo_ids]
});

export const liveProfileOf = (accountId: number) =>
  mockSparkProfiles.find((p) => p.account_id === accountId && p.status === 'active');

export const blockedEitherWay = (a: number, b: number) =>
  mockSparkBlocks.some(
    (x) => (x.blocker === a && x.blocked === b) || (x.blocker === b && x.blocked === a)
  );

export const matchBetween = (a: number, b: number) =>
  mockSparkMatches.find((m) => (m.a === a && m.b === b) || (m.a === b && m.b === a));

/** The match as one side sees it: the other side's card. Null when that profile is gone. */
export const toMatch = (match: MockSparkMatch, viewer: number): SparkMatch | null => {
  const other = match.a === viewer ? match.b : match.a;
  const profile = liveProfileOf(other);
  return profile ? { id: match.id, profile: toCard(profile), created_at: match.created_at } : null;
};

/** Drop the thread between two accounts — an unmatch, a block or a deleted profile takes it. */
export const dropThread = (a: number, b: number): void => {
  for (const dm of mockDms) {
    if (
      (dm.from_account === a && dm.to_account === b) ||
      (dm.from_account === b && dm.to_account === a)
    ) {
      dm.status = 'deleted';
    }
  }
};

/**
 * The seeded liker answers a match with one message, so the thread the e2e lane opens after
 * matching has something from the peer in it. Anyone else stays quiet.
 */
export const seedOpener = (peer: number, me: number): void => {
  if (peer !== SPARK_SEED.maya.account) return;
  const now = new Date().toISOString();
  mockDms.push({
    id: nextMockDmId(),
    from_account: peer,
    to_account: me,
    body: SPARK_OPENER,
    read_at: null,
    status: 'active',
    created_at: now,
    updated_at: now
  });
};
