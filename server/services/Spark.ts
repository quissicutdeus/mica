// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from 'node:crypto';
import { PlayerFacingError } from '../lib/errors';
import { defineService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { appEventChannel } from '../lib/appEvents';
import { resolveOwnedAttachments } from '../lib/attachments';
import { pageBounds } from '../lib/payload';
import { isDuplicateKey, reasonOf } from '../lib/sqlErrors';
import { RETENTION_BATCH } from '../lib/contentRetention';
import { recordOwnerDeletion } from '../lib/moderation';
import { whenSchemaReady } from '../lib/schemaReady';
import { AccountRepository, accounts, accountHasBlocked, scrubAccount } from './Accounts';
import { deleteThread, type DmPolicy } from './DirectMessages';
import { defineSocialApp } from '../lib/socialApp';
import { media } from './Media';
import { onBeforeSelfServiceDelete } from './Privacy';
import { defineContract, responseType } from '@mica/shared/contract';
import { s } from '@mica/shared/schema';
import { MAX_ATTACHMENTS } from '@mica/shared/attachments';
import { buildDeepLink } from '@mica/shared/deepLink';
import type {
  Account,
  MediaPreview,
  SparkCard,
  SparkMatch,
  SparkPhoto,
  SparkProfile
} from '@mica/shared/types';

/** The app id. Also the namespace of the one account each player holds here. */
export const SPARK_APP = 'spark';

export const DISPLAY_NAME_MAX = 32;
export const BIO_MAX = 300;
export const LOOKING_FOR_MAX = 60;
export const AGE_MIN = 18;
export const AGE_MAX = 99;

/** How long a pass keeps a profile out of the passer's deck. A constant, not a convar. */
export const PASS_DAYS = 14;

/** `matches` answers at most this many, newest first. */
export const MATCHES_CAP = 100;

/** The deck's page: small, because every card carries up to four photos. */
export const DECK_PAGING = { pageSize: 10, maxPageSize: 20 } as const;

const PROFILES = 'mica_spark';
const PHOTOS = 'mica_spark_photos';
const SWIPES = 'mica_spark_swipes';
const MATCHES = 'mica_spark_matches';

/**
 * Spark's contract (MICA-255), declared here beside its `defineService` for Glimpse's reason:
 * Spark is `core: false`, and core may not name an app the Store installs
 * (`sdk/coreBoundary.test.ts`).
 *
 * Every generic action is off. None of these schemas authorizes anything: every handler decides
 * from the session's citizenid, never from an id in the payload (§2.9).
 */
export const sparkContract = defineContract({
  id: SPARK_APP,
  actions: {
    /** The caller's own profile, active or taken down, or null. */
    mine: { input: s.object({}), output: responseType<SparkProfile | null>() },
    /**
     * Opt in, or edit. One action for both: the first save makes the caller's one Spark account
     * and their profile; every later one rewrites them. Photos are the caller's own gallery
     * photos, in the order given, and replace the whole set.
     */
    save: {
      input: s.object({
        display_name: s.string({ min: 1, max: DISPLAY_NAME_MAX, trim: true }),
        age: s.int({ min: AGE_MIN, max: AGE_MAX }),
        bio: s.string({ max: BIO_MAX }).nullable().optional(),
        looking_for: s.string({ max: LOOKING_FOR_MAX }).nullable().optional(),
        photos: s.array(s.object({ photo_id: s.positiveInt() }), { min: 1, max: MAX_ATTACHMENTS })
      }),
      output: responseType<SparkProfile>()
    },
    /** Delete the profile: matches, swipes and threads go with it. The account stays. */
    remove: { input: s.object({}), output: responseType<boolean>() },
    /** Profiles to swipe on, newest first, keyset-paged. Refused without a live profile. */
    deck: {
      input: s.object({
        cursor: s.positiveInt().nullable().optional(),
        limit: s.positiveInt().optional()
      }),
      output: responseType<{ rows: SparkCard[]; nextCursor: number | null }>()
    },
    /** Like or pass. A like answered by a like is a match, and the answer carries it. */
    swipe: {
      input: s.object({ profile_id: s.positiveInt(), verdict: s.enum(['like', 'pass']) }),
      output: responseType<{ match: SparkMatch | null }>()
    },
    /** The caller's matches, newest first, at most `MATCHES_CAP`. */
    matches: { input: s.object({}), output: responseType<SparkMatch[]>() },
    /**
     * End a match and the conversation with it. Both likes stay, so the pair does not match again
     * while both profiles exist; a profile removed and made again starts with no swipes, and only
     * a block outlives that.
     */
    unmatch: { input: s.object({ match_id: s.positiveInt() }), output: responseType<boolean>() },
    /** Block the account behind a profile, ending any match with it. */
    block: { input: s.object({ profile_id: s.positiveInt() }), output: responseType<boolean>() }
  }
});

interface ProfileRow {
  id: number;
  citizenid: string;
  account_id: number;
  age: number;
  bio: string | null;
  looking_for: string | null;
  status: 'active' | 'deleted' | 'moderated';
}

/**
 * Spark profiles (MICA-255): one per player, on the one unlisted Spark account they hold.
 *
 * **One live profile per citizen**, held by `live_citizen`, which is the citizenid on every row
 * that is not `deleted`. A taken-down profile keeps holding it, so a moderated player cannot
 * simply make a fresh one; a deleted one does not, so removing a profile and making it again is
 * a new row, and a report filed against the old one still reads the old words.
 *
 * `account_id` is **not** unique (a change from the brief, MICA-255): nothing deletes an account,
 * so a unique key on it would refuse every profile made after a `remove`, and reviving the old
 * row in place would put the new profile under any report filed against the old one. Two live
 * profiles on one account would need two live profiles on one citizen, which `live_citizen`
 * already refuses.
 *
 * Swipes and matches carry no owner column and no foreign key reaches them: the purge keeps any
 * parent another player's surviving row references (`sweep/purge.ts`'s cascade guard), and a
 * deleted profile kept for another player's swipe would stay in decks. They are
 * `CASCADE_DEPENDENTS` in `Privacy.ts` instead.
 */
export const spark = defineService<ProfileRow, typeof sparkContract>({
  contract: sparkContract,
  id: SPARK_APP,
  app: SPARK_APP,
  reportable: { label: 'Dating profile', previewColumn: 'bio' },
  access: { read: 'owner', write: 'owner' },
  statuses: ['active', 'deleted', 'moderated'],
  schema: {
    account_id: {
      type: 'int',
      notNull: true,
      clientWritable: false,
      references: { table: 'mica_accounts', column: 'id' }
    },
    /** In character, at least 18 (`AGE_MIN`). */
    age: { type: 'int', notNull: true, clientWritable: false },
    bio: { type: 'string', length: BIO_MAX, clientWritable: false },
    looking_for: { type: 'string', length: LOOKING_FOR_MAX, clientWritable: false },
    /** The citizenid while the profile is not deleted; carries the one-live-profile key. */
    live_citizen: {
      type: 'string',
      citizenId: true,
      generatedAs: "CASE WHEN `status` <> 'deleted' THEN `citizenid` ELSE NULL END"
    }
  },
  indexes: [
    { name: 'live_citizen', columns: ['live_citizen'], unique: true },
    { name: 'account_id', columns: ['account_id'] }
  ],
  uniqueAfterDelete: {
    optOut:
      '`live_citizen` is NULL on a deleted row, so a profile made again is a new row and ' +
      'nothing needs reviving; a moderated row keeps the key so a taken-down player cannot ' +
      'make a fresh profile'
  },
  childTables: [
    {
      /** A profile's photos, in order: the owner's own gallery rows, never projected by id. */
      name: PHOTOS,
      columns: {
        profile_id: { type: 'int', notNull: true, references: { table: PROFILES, column: 'id' } },
        citizenid: { type: 'string', citizenId: true, notNull: true },
        media_id: {
          type: 'int',
          notNull: true,
          references: { table: 'mica_media', column: 'id' }
        },
        position: { type: 'int', notNull: true }
      },
      indexes: [
        { name: 'profile_position', columns: ['profile_id', 'position'] },
        { name: 'citizenid', columns: ['citizenid'] },
        { name: 'media_id', columns: ['media_id'] }
      ]
    },
    {
      /**
       * One row per (swiper, target), written by an upsert so a pass can become a like. A like
       * is never taken back by a later swipe: it is what stops an unmatched pair matching again,
       * for as long as both profiles exist (a removed profile's swipes go with it).
       */
      name: SWIPES,
      columns: {
        swiper_profile_id: {
          type: 'int',
          notNull: true,
          references: { table: PROFILES, column: 'id' }
        },
        target_profile_id: {
          type: 'int',
          notNull: true,
          references: { table: PROFILES, column: 'id' }
        },
        kind: { type: 'enum', values: ['like', 'pass'], notNull: true },
        created_at: { type: 'timestamp', notNull: true, defaultNow: true }
      },
      indexes: [
        {
          name: 'swiper_target',
          columns: ['swiper_profile_id', 'target_profile_id'],
          unique: true
        },
        { name: 'target_profile_id', columns: ['target_profile_id'] },
        /** The sweep's walk over old passes. */
        { name: 'kind_created_at', columns: ['kind', 'created_at'] }
      ],
      uniqueAfterDelete: {
        optOut:
          'a swipe is never soft-deleted: a second swipe on the same profile is an upsert onto ' +
          'the row, and a removal or an expired pass is a hard delete'
      }
    },
    {
      /** A mutual like, stored once with `profile_a < profile_b`. */
      name: MATCHES,
      columns: {
        profile_a: { type: 'int', notNull: true, references: { table: PROFILES, column: 'id' } },
        profile_b: { type: 'int', notNull: true, references: { table: PROFILES, column: 'id' } },
        created_at: { type: 'timestamp', notNull: true, defaultNow: true }
      },
      indexes: [
        { name: 'pair', columns: ['profile_a', 'profile_b'], unique: true },
        { name: 'profile_b', columns: ['profile_b'] }
      ],
      uniqueAfterDelete: {
        optOut:
          'a match is hard-deleted by an unmatch, and both like rows stay, so the pair is never ' +
          'inserted again; a second insert of a live pair is the race `swipe` reads back'
      }
    }
  ],
  options: { disableGet: true, disableCreate: true, disableUpdate: true, disableDelete: true }
});

const app = spark.app;
const channel = appEventChannel(SPARK_APP);

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

/** Self, blocked, deleted, taken down and missing all read alike. */
const gone = (): PlayerFacingError =>
  new PlayerFacingError('That profile is gone.', { key: 'server.spark.gone' });

const needsProfile = (): PlayerFacingError =>
  new PlayerFacingError('Make your Spark profile first.', { key: 'server.spark.needsProfile' });

const needsPhoto = (): PlayerFacingError =>
  new PlayerFacingError('Pick at least one photo.', { key: 'server.spark.needsPhoto' });

const takenDown = (): PlayerFacingError =>
  new PlayerFacingError('Your Spark profile was taken down.', {
    key: 'server.spark.takenDown'
  });

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

const marks = (ids: readonly unknown[]): string => ids.map(() => '?').join(', ');

const PROFILE_COLUMNS =
  '`id`, `citizenid`, `account_id`, `age`, `bio`, `looking_for`, `status`' as const;

/** The caller's profile that is not deleted — active or taken down — or null. */
const liveProfileOf = async (citizenid: string): Promise<ProfileRow | null> =>
  await Database.single<ProfileRow | null>(
    `SELECT ${PROFILE_COLUMNS} FROM \`${PROFILES}\`
     WHERE \`citizenid\` = ? AND \`status\` <> 'deleted' LIMIT 1`,
    [citizenid]
  );

/** The caller's active profile, or the refusal every action past opt-in answers. */
const requireActiveProfile = async (citizenid: string): Promise<ProfileRow> => {
  const mine = await liveProfileOf(citizenid);
  if (!mine || mine.status !== 'active') throw needsProfile();
  return mine;
};

/**
 * Another player's profile the caller may act on: active, on an active account, not the
 * caller's, and no block either way. Every miss is `gone()`.
 */
const reachableProfile = async (profileId: number, mine: ProfileRow): Promise<ProfileRow> => {
  const target = await Database.single<ProfileRow | null>(
    `SELECT s.\`id\`, s.\`citizenid\`, s.\`account_id\`, s.\`age\`, s.\`bio\`, s.\`looking_for\`, s.\`status\`
     FROM \`${PROFILES}\` s
     JOIN \`mica_accounts\` a ON a.\`id\` = s.\`account_id\` AND a.\`status\` = 'active'
     WHERE s.\`id\` = ? AND s.\`status\` = 'active' LIMIT 1`,
    [profileId]
  );
  if (!target || target.citizenid === mine.citizenid || Number(target.id) === Number(mine.id)) {
    throw gone();
  }
  if (await blockedEitherWay(Number(mine.account_id), Number(target.account_id))) throw gone();
  return target;
};

const blockedEitherWay = async (a: number, b: number): Promise<boolean> =>
  (await accountHasBlocked(a, b)) || (await accountHasBlocked(b, a));

interface PhotoRow {
  id: number;
  profile_id: number;
  media_id: number;
  kind: string | null;
  data: unknown;
  url: string | null;
  thumbnail: unknown;
  mime_type: string | null;
  duration_ms: number | null;
  alt_text: string | null;
}

/**
 * Each profile's photos whose gallery row is still active, in the owner's order. A photo deleted
 * from the gallery leaves the profile. Never selects a citizenid.
 */
const photosFor = async (
  profileIds: readonly number[]
): Promise<Map<number, { photo: SparkPhoto; mediaId: number }[]>> => {
  const ids = [...new Set(profileIds)];
  const out = new Map<number, { photo: SparkPhoto; mediaId: number }[]>();
  if (ids.length === 0) return out;
  const rows = await Database.query<PhotoRow[]>(
    `SELECT p.\`id\`, p.\`profile_id\`, p.\`media_id\`,
            m.\`kind\`, m.\`data\`, m.\`url\`, m.\`thumbnail\`, m.\`mime_type\`, m.\`duration_ms\`, m.\`alt_text\`
     FROM \`${PHOTOS}\` p
     JOIN \`mica_media\` m ON m.\`id\` = p.\`media_id\` AND m.\`status\` = 'active'
     WHERE p.\`profile_id\` IN (${marks(ids)})
     ORDER BY p.\`profile_id\`, p.\`position\`, p.\`id\``,
    ids
  );
  for (const row of rows ?? []) {
    const preview: Omit<MediaPreview, 'id'> = {
      kind: (row.kind ?? 'photo') as MediaPreview['kind'],
      // A `mediumtext` can arrive as a Buffer, which crosses NUI as `{type:'Buffer'}`.
      data: row.data ? String(row.data) : undefined,
      url: row.url ?? undefined,
      thumbnail: row.thumbnail ? String(row.thumbnail) : undefined,
      mime_type: row.mime_type ?? undefined,
      duration_ms: row.duration_ms ?? undefined,
      alt_text: row.alt_text ?? undefined
    };
    const profileId = Number(row.profile_id);
    const list = out.get(profileId) ?? [];
    // At most `MAX_ATTACHMENTS`, in order, whatever the table holds.
    if (list.length >= MAX_ATTACHMENTS) continue;
    list.push({ photo: { id: Number(row.id), media: preview }, mediaId: Number(row.media_id) });
    out.set(profileId, list);
  }
  return out;
};

/** Display names, by account id. Any status: the owner's own card still shows theirs. */
const displayNames = async (accountIds: readonly number[]): Promise<Map<number, string | null>> => {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return new Map();
  const rows = await Database.query<{ id: number; display_name: string | null }[]>(
    `SELECT \`id\`, \`display_name\` FROM \`mica_accounts\` WHERE \`id\` IN (${marks(ids)})`,
    ids
  );
  return new Map((rows ?? []).map((row) => [Number(row.id), row.display_name ?? null]));
};

/**
 * Rows as cards: exactly the `SparkCard` fields, built field by field so nothing a query selected
 * — the citizenid above all — rides along. A profile left with no active photo is dropped.
 */
const toCards = async (rows: readonly ProfileRow[]): Promise<SparkCard[]> => {
  const photos = await photosFor(rows.map((row) => Number(row.id)));
  const names = await displayNames(rows.map((row) => Number(row.account_id)));
  const cards: SparkCard[] = [];
  for (const row of rows) {
    const set = photos.get(Number(row.id)) ?? [];
    if (set.length === 0) continue;
    cards.push({
      id: Number(row.id),
      account_id: Number(row.account_id),
      display_name: names.get(Number(row.account_id)) ?? null,
      age: Number(row.age),
      bio: row.bio ?? null,
      looking_for: row.looking_for ?? null,
      photos: set.map((entry) => entry.photo)
    });
  }
  return cards;
};

/** The owner's own view: the card, its status, and the gallery ids behind the photos. */
const toProfile = async (row: ProfileRow): Promise<SparkProfile> => {
  const set = (await photosFor([Number(row.id)])).get(Number(row.id)) ?? [];
  const names = await displayNames([Number(row.account_id)]);
  return {
    id: Number(row.id),
    account_id: Number(row.account_id),
    display_name: names.get(Number(row.account_id)) ?? null,
    age: Number(row.age),
    bio: row.bio ?? null,
    looking_for: row.looking_for ?? null,
    photos: set.map((entry) => entry.photo),
    status: row.status,
    photo_ids: set.map((entry) => entry.mediaId)
  };
};

/**
 * Active profiles on active accounts, by id. With `viewerAccount`, also none with a block either
 * way between it and the viewer: a match the blocker made through `accounts:block`, which never
 * ends a Spark match, drops out of Matches as it drops out of the deck.
 */
const activeProfiles = async (
  ids: readonly number[],
  viewerAccount?: number
): Promise<ProfileRow[]> => {
  if (ids.length === 0) return [];
  const viewer = viewerAccount === undefined ? '' : NOT_BLOCKED_BY_OR_OF_VIEWER;
  const params: unknown[] = [...ids];
  if (viewerAccount !== undefined) params.push(viewerAccount, viewerAccount);
  return (
    (await Database.query<ProfileRow[]>(
      `SELECT s.\`id\`, s.\`citizenid\`, s.\`account_id\`, s.\`age\`, s.\`bio\`, s.\`looking_for\`, s.\`status\`
       FROM \`${PROFILES}\` s
       JOIN \`mica_accounts\` a ON a.\`id\` = s.\`account_id\` AND a.\`status\` = 'active'
       WHERE s.\`id\` IN (${marks(ids)}) AND s.\`status\` = 'active'${viewer}`,
      params
    )) ?? []
  );
};

/** Bound as `[viewer, viewer]`. The deck's two block clauses, for `activeProfiles`. */
const NOT_BLOCKED_BY_OR_OF_VIEWER =
  ' AND NOT EXISTS (SELECT 1 FROM `mica_account_blocks` b' +
  ' WHERE b.`blocker_account_id` = ? AND b.`blocked_account_id` = s.`account_id`)' +
  ' AND NOT EXISTS (SELECT 1 FROM `mica_account_blocks` b' +
  ' WHERE b.`blocker_account_id` = s.`account_id` AND b.`blocked_account_id` = ?)';

// ---------------------------------------------------------------------------------------------
// The match between two accounts, for the DM policy
// ---------------------------------------------------------------------------------------------

/**
 * Whether the two accounts' profiles hold a live match: both profiles active, the match row
 * present, no block either way. The DM policy's whole question.
 */
export const accountsMatched = async (a: number, b: number): Promise<boolean> => {
  if (a === b) return false;
  const row = await Database.single<unknown>(
    `SELECT 1 FROM \`${MATCHES}\` m
     JOIN \`${PROFILES}\` pa ON pa.\`id\` = m.\`profile_a\` AND pa.\`status\` = 'active'
     JOIN \`${PROFILES}\` pb ON pb.\`id\` = m.\`profile_b\` AND pb.\`status\` = 'active'
     WHERE (pa.\`account_id\` = ? AND pb.\`account_id\` = ?)
        OR (pa.\`account_id\` = ? AND pb.\`account_id\` = ?)
     LIMIT 1`,
    [a, b, b, a]
  );
  if (!row) return false;
  return !(await blockedEitherWay(a, b));
};

/**
 * Spark's DMs: only between matched accounts, and the notification names nobody — it shows on
 * the lock screen, so it says only that a message came. The deep link carries the sender's
 * account id, which the recipient's match list already holds as `profile.account_id`; the
 * policy's `notify` is synchronous and handed only the sender, so a match id is not
 * computable here without racing another send. Registered with the rest by `defineSocialApp`
 * below.
 */
const sparkDms: DmPolicy = {
  canSend: async (mine: Account, peer: Account) => await accountsMatched(mine.id, peer.id),
  canRead: async (mine: Account, peer: Account) => await accountsMatched(mine.id, peer.id),
  notify: (from: Account) => ({
    title: 'Spark',
    message: 'New message',
    deepLink: buildDeepLink(SPARK_APP, { accountId: from.id })
  })
};

// ---------------------------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------------------------

/** Narrowed by `instanceof` rather than cast, so a factory change fails loudly at load. */
const accountRepo = accounts.repo;
if (!(accountRepo instanceof AccountRepository)) {
  throw new Error('Spark: the accounts repository is not an AccountRepository.');
}

/** Draws before a handle collision is treated as something other than bad luck. */
const HANDLE_ATTEMPTS = 5;

/** ER 1213. oxmysql carries no errno (agent memory), so the driver's text is asked as well. */
export const isDeadlock = (error: unknown): boolean => {
  if (error && typeof error === 'object') {
    const { errno, code } = error as { errno?: unknown; code?: unknown };
    if (errno === 1213 || code === 'ER_LOCK_DEADLOCK') return true;
  }
  const text = reasonOf(error);
  return /\bDeadlock found when trying to get lock\b/i.test(text);
};

/** A handle nobody reads: Spark accounts are unlisted, and the handle is no part of a card. */
const drawHandle = (): string => `sp_${randomBytes(8).toString('hex')}`;

/**
 * The caller's one Spark account, made on first use. A taken-down account refuses: making a
 * second one beside it would undo the takedown. Two first saves at once: the cap predicate
 * refuses the second insert, or InnoDB deadlocks the two (both took the shared gap lock the
 * count reads under), and either way the loser reads the winner's row on the next round.
 */
const sparkAccountOf = async (citizenid: string, displayName: string): Promise<number> => {
  for (let attempt = 1; ; attempt += 1) {
    const held = await Database.query<{ id: number; status: string }[]>(
      `SELECT \`id\`, \`status\` FROM \`mica_accounts\`
       WHERE \`citizenid\` = ? AND \`app\` = ? ORDER BY \`id\``,
      [citizenid, SPARK_APP]
    );
    const active = (held ?? []).find((row) => row.status === 'active');
    if (active) return Number(active.id);
    if ((held ?? []).some((row) => row.status === 'moderated')) throw takenDown();

    try {
      const id = await accountRepo.createWithinCap(
        { citizenid, app: SPARK_APP, handle: drawHandle(), display_name: displayName },
        1
      );
      if (id) return Number(id);
    } catch (error) {
      // A taken handle, or the cap's INSERT … SELECT deadlocking against another first save
      // for the same citizen: either way the next round reads again, and finds that save's row.
      if (!isDuplicateKey(error) && !isDeadlock(error)) throw error;
    }
    if (attempt >= HANDLE_ATTEMPTS) {
      throw new Error('Spark: could not make an account after several attempts.');
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Pushes
// ---------------------------------------------------------------------------------------------

/** Never allowed to fail the write that occasioned it. */
const pushQuietly = (run: () => unknown, what: string): void => {
  try {
    run();
  } catch (error) {
    console.error(`[spark] ${what} push failed:`, error);
  }
};

/** Tell the other side a match ended. Silent: no toast, no notification row. */
const pushUnmatched = (citizenid: string, matchId: number): void =>
  pushQuietly(
    () => channel.push(citizenid, 'unmatched', { match_id: matchId }, { persist: false }),
    'unmatched'
  );

// ---------------------------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------------------------

interface MatchRow {
  id: number;
  profile_a: number;
  profile_b: number;
  created_at: Date | string;
}

const matchOf = async (a: number, b: number): Promise<MatchRow | null> =>
  await Database.single<MatchRow | null>(
    `SELECT \`id\`, \`profile_a\`, \`profile_b\`, \`created_at\` FROM \`${MATCHES}\`
     WHERE \`profile_a\` = ? AND \`profile_b\` = ? LIMIT 1`,
    [Math.min(a, b), Math.max(a, b)]
  );

/**
 * A match as the caller sees it: the other side's card. Null when that card is gone or a block
 * stands between the two.
 */
const toMatch = async (row: MatchRow, mine: ProfileRow): Promise<SparkMatch | null> => {
  const mineId = Number(mine.id);
  const otherId = Number(row.profile_a) === mineId ? Number(row.profile_b) : Number(row.profile_a);
  const [card] = await toCards(await activeProfiles([otherId], Number(mine.account_id)));
  return card ? { id: Number(row.id), profile: card, created_at: row.created_at } : null;
};

/**
 * End one match: the thread first, so a failure leaves the match to retry from; then the row,
 * under a predicate naming the caller's profile. Answers the other side's citizenid when this
 * call removed it.
 */
const endMatch = async (
  match: MatchRow,
  mine: { id: number; account_id: number }
): Promise<string | null> => {
  const otherId =
    Number(match.profile_a) === mine.id ? Number(match.profile_b) : Number(match.profile_a);
  const other = await Database.single<{ account_id: number; citizenid: string } | null>(
    `SELECT \`account_id\`, \`citizenid\` FROM \`${PROFILES}\` WHERE \`id\` = ? LIMIT 1`,
    [otherId]
  );
  if (other) await deleteThread(mine.account_id, Number(other.account_id));
  const removed = await Database.update(
    `DELETE FROM \`${MATCHES}\` WHERE \`id\` = ? AND (\`profile_a\` = ? OR \`profile_b\` = ?)`,
    [match.id, mine.id, mine.id]
  );
  return removed && other ? String(other.citizenid) : null;
};

/** Both profiles still active on active accounts, and no block either way. */
const pairStillOpen = async (mine: ProfileRow, target: ProfileRow): Promise<boolean> => {
  const live = await activeProfiles([Number(mine.id), Number(target.id)]);
  if (live.length !== 2) return false;
  return !(await blockedEitherWay(Number(mine.account_id), Number(target.account_id)));
};

/**
 * Everything a profile leaves in other players' hands, gone: each match's thread and row, then
 * every swipe either way. Threads before rows, so a failure part-way leaves what is left to a
 * retry. The silent `unmatched` pushes go only after everything is written.
 */
const forgetProfile = async (profileId: number, accountId: number): Promise<void> => {
  const matches = await Database.query<MatchRow[]>(
    `SELECT \`id\`, \`profile_a\`, \`profile_b\`, \`created_at\` FROM \`${MATCHES}\`
     WHERE \`profile_a\` = ? OR \`profile_b\` = ?`,
    [profileId, profileId]
  );
  const told: { citizenid: string; matchId: number }[] = [];
  for (const match of matches ?? []) {
    const other = await endMatch(match, { id: profileId, account_id: accountId });
    if (other) told.push({ citizenid: other, matchId: Number(match.id) });
  }
  await Database.update(
    `DELETE FROM \`${SWIPES}\` WHERE \`swiper_profile_id\` = ? OR \`target_profile_id\` = ?`,
    [profileId, profileId]
  );
  for (const { citizenid, matchId } of told) pushUnmatched(citizenid, matchId);
};

/**
 * A player's profile, removed: soft-deleted if active (a taken-down one stays where the
 * moderator put it, holding its key), its matches, threads and swipes gone, and the account
 * blanked. Answers whether the player had a profile to remove.
 *
 * **The player's removal wins a takedown's restore** (MICA-426). A moderated profile cannot be
 * moved to `deleted` — it is the evidence — but everything that made it a profile goes below,
 * so a reopen putting it back `active` would return a card its owner removed, matchless and
 * blank, to every deck. Its takedowns are recorded as the owner's deletion instead, and a
 * reopen restores `deleted`.
 */
const removeProfiles = async (citizenid: string): Promise<boolean> => {
  const rows = await Database.query<{ id: number; account_id: number; status: string }[]>(
    `SELECT \`id\`, \`account_id\`, \`status\` FROM \`${PROFILES}\` WHERE \`citizenid\` = ?`,
    [citizenid]
  );
  let had = false;
  const accountIds = new Set<number>();
  for (const row of rows ?? []) {
    const id = Number(row.id);
    accountIds.add(Number(row.account_id));
    if (row.status !== 'deleted') {
      had = true;
      // Deleted first, then forgotten: a swipe that lands in between meets a profile no longer
      // active, and its own re-check takes back any match it made (`pairStillOpen`).
      const softDelete = () =>
        Database.update(
          `UPDATE \`${PROFILES}\` SET \`status\` = 'deleted'
           WHERE \`id\` = ? AND \`citizenid\` = ? AND \`status\` = 'active'`,
          [id, citizenid]
        );
      if (!(await softDelete())) {
        /**
         * Not active: moderated, or taken down since the read above. Recorded behind any
         * decision in flight about the row, so a takedown's own record lands first and is the
         * one replaced; then the soft delete again, for a reopen that put it back live while
         * this waited.
         */
        await recordOwnerDeletion(PROFILES, [id]);
        await softDelete();
      }
    }
    // Every profile, deleted ones too: a removal that failed part-way left its profile deleted
    // with matches still on it, and the retry has to find them.
    await forgetProfile(id, Number(row.account_id));
  }
  // False on a taken-down account, which keeps what the moderator saw: ignored.
  for (const accountId of accountIds) await scrubAccount(accountId, citizenid);
  return had;
};

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

/** A photo the caller owns and still has, as Glimpse asks it. A row with no `kind` is a photo. */
const ownedPhotos = {
  findById: async (id: number, citizenid: string) => {
    const row = await media.repo.findById(id, citizenid);
    return row && (row.kind ?? 'photo') === 'photo' ? row : null;
  }
};

app.registerEvent('mine', async (_source, _cbId, _data, citizenid) => {
  const mine = await liveProfileOf(citizenid);
  return mine ? await toProfile(mine) : null;
});

app.registerEvent('save', async (_source, _cbId, data, citizenid) => {
  const displayName = data.display_name.trim();
  const bio = data.bio?.trim() || null;
  const lookingFor = data.looking_for?.trim() || null;

  // Before anything is written: only the caller's own live photos survive, deduplicated.
  const photos = await resolveOwnedAttachments(data.photos, citizenid, ownedPhotos);
  if (photos.length === 0) throw needsPhoto();

  const existing = await liveProfileOf(citizenid);
  if (existing && existing.status !== 'active') throw takenDown();

  const accountId = await sparkAccountOf(citizenid, displayName);
  // The owner-scoped update, which names the citizen and never reaches a moderated row.
  await accounts.repo.update(accountId, { display_name: displayName }, citizenid);

  let profileId: number;
  if (existing) {
    profileId = Number(existing.id);
  } else {
    try {
      profileId = await Database.insert(
        `INSERT INTO \`${PROFILES}\` (\`citizenid\`, \`account_id\`, \`age\`, \`bio\`, \`looking_for\`)
         VALUES (?, ?, ?, ?, ?)`,
        [citizenid, accountId, data.age, bio, lookingFor]
      );
    } catch (error) {
      // Two first saves at once: `live_citizen` refused the second, which edits the first.
      if (!isDuplicateKey(error)) throw error;
      const raced = await liveProfileOf(citizenid);
      if (!raced) throw error;
      if (raced.status !== 'active') throw takenDown();
      profileId = Number(raced.id);
    }
  }

  const updated = await Database.update(
    `UPDATE \`${PROFILES}\` SET \`age\` = ?, \`bio\` = ?, \`looking_for\` = ?
     WHERE \`id\` = ? AND \`citizenid\` = ? AND \`status\` = 'active'`,
    [data.age, bio, lookingFor, profileId, citizenid]
  );
  if (!updated) {
    const now = await liveProfileOf(citizenid);
    if (!now || now.status !== 'active') throw takenDown();
  }

  // One transaction, so two saves at once cannot leave both photo sets on the profile.
  const replaced = await Database.transaction([
    {
      query: `DELETE FROM \`${PHOTOS}\` WHERE \`profile_id\` = ? AND \`citizenid\` = ?`,
      params: [profileId, citizenid]
    },
    {
      query: `INSERT INTO \`${PHOTOS}\` (\`profile_id\`, \`citizenid\`, \`media_id\`, \`position\`) VALUES ${photos
        .map(() => '(?, ?, ?, ?)')
        .join(', ')}`,
      params: photos.flatMap((photo, position) => [profileId, citizenid, photo.photo_id, position])
    }
  ]);
  if (!replaced) throw new Error('Spark: the photo set could not be replaced.');

  const saved = await liveProfileOf(citizenid);
  if (!saved) throw takenDown();
  return await toProfile(saved);
});

app.registerEvent('remove', async (_source, _cbId, _data, citizenid) => {
  return await removeProfiles(citizenid);
});

/**
 * The deck: active profiles on active accounts, not the caller's, with at least one active
 * photo, that the caller has neither liked nor passed on in the last `PASS_DAYS`, with no block
 * either way. Newest first by id, keyset with a probe row. Nothing about the other person's
 * swipes enters the query, so neither the order nor the membership says whether they liked you.
 */
app.registerEvent('deck', async (_source, _cbId, data, citizenid) => {
  const mine = await requireActiveProfile(citizenid);
  const { limit, cursor } = pageBounds(data, DECK_PAGING);
  const params: unknown[] = [citizenid, mine.id, PASS_DAYS, mine.account_id, mine.account_id];
  const cursorClause = cursor === null ? '' : ' AND s.`id` < ?';
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows =
    (await Database.query<ProfileRow[]>(
      `SELECT s.\`id\`, s.\`citizenid\`, s.\`account_id\`, s.\`age\`, s.\`bio\`, s.\`looking_for\`, s.\`status\`
       FROM \`${PROFILES}\` s
       JOIN \`mica_accounts\` a ON a.\`id\` = s.\`account_id\` AND a.\`status\` = 'active'
       WHERE s.\`status\` = 'active'
         AND s.\`citizenid\` <> ?
         AND EXISTS (SELECT 1 FROM \`${PHOTOS}\` p
                     JOIN \`mica_media\` m ON m.\`id\` = p.\`media_id\` AND m.\`status\` = 'active'
                     WHERE p.\`profile_id\` = s.\`id\`)
         AND NOT EXISTS (SELECT 1 FROM \`${SWIPES}\` w
                         WHERE w.\`swiper_profile_id\` = ? AND w.\`target_profile_id\` = s.\`id\`
                           AND (w.\`kind\` = 'like' OR w.\`created_at\` > NOW() - INTERVAL ? DAY))
         AND NOT EXISTS (SELECT 1 FROM \`mica_account_blocks\` b
                         WHERE b.\`blocker_account_id\` = ? AND b.\`blocked_account_id\` = s.\`account_id\`)
         AND NOT EXISTS (SELECT 1 FROM \`mica_account_blocks\` b
                         WHERE b.\`blocker_account_id\` = s.\`account_id\` AND b.\`blocked_account_id\` = ?)${cursorClause}
       ORDER BY s.\`id\` DESC
       LIMIT ?`,
      params
    )) ?? [];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: await toCards(page),
    nextCursor: hasMore ? Number(page[page.length - 1].id) : null
  };
});

/**
 * Like or pass. A like answered by the other side's like is a match: inserted once, on the
 * pair's unique key, and the insert that wins tells both players. A like the caller had already
 * given makes no match — that is the pair an unmatch or a block ended, whose likes stay.
 *
 * The winning insert asks again, after it is written, whether the pair is still open: both
 * profiles active and no block either way. A block or a remove that landed while this request
 * was in flight finds no match to end — it read before the insert — so the insert takes itself
 * back: the match and its thread go, nobody is told, and the answer is no match. Each side
 * writes before it reads the other's write, so one of the two always sees the other.
 */
app.registerEvent('swipe', async (_source, _cbId, data, citizenid) => {
  const mine = await requireActiveProfile(citizenid);
  const target = await reachableProfile(data.profile_id, mine);
  const mineId = Number(mine.id);
  const targetId = Number(target.id);

  const prior = await Database.scalar<string | null>(
    `SELECT \`kind\` FROM \`${SWIPES}\` WHERE \`swiper_profile_id\` = ? AND \`target_profile_id\` = ?`,
    [mineId, targetId]
  );

  // `created_at` before `kind`: MariaDB applies SET left to right, so the stamp reads the kind
  // as it was. A like stays a like, with its stamp; a pass becomes whatever was sent, stamped now.
  await Database.query(
    `INSERT INTO \`${SWIPES}\` (\`swiper_profile_id\`, \`target_profile_id\`, \`kind\`)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       \`created_at\` = IF(\`kind\` = 'like', \`created_at\`, CURRENT_TIMESTAMP),
       \`kind\` = IF(\`kind\` = 'like', 'like', VALUES(\`kind\`))`,
    [mineId, targetId, data.verdict]
  );

  if (data.verdict !== 'like') return { match: null };
  if (prior === 'like') {
    const existing = await matchOf(mineId, targetId);
    return { match: existing ? await toMatch(existing, mine) : null };
  }

  const likedBack = await Database.single<unknown>(
    `SELECT 1 FROM \`${SWIPES}\`
     WHERE \`swiper_profile_id\` = ? AND \`target_profile_id\` = ? AND \`kind\` = 'like' LIMIT 1`,
    [targetId, mineId]
  );
  if (!likedBack) return { match: null };

  let matchId: number;
  let won = false;
  try {
    matchId = await Database.insert(
      `INSERT INTO \`${MATCHES}\` (\`profile_a\`, \`profile_b\`) VALUES (?, ?)`,
      [Math.min(mineId, targetId), Math.max(mineId, targetId)]
    );
    won = true;
  } catch (error) {
    // The other like's request inserted it first; read theirs, and leave the telling to it.
    if (!isDuplicateKey(error)) throw error;
    const existing = await matchOf(mineId, targetId);
    if (!existing) throw error;
    matchId = Number(existing.id);
  }

  if (won && !(await pairStillOpen(mine, target))) {
    const inserted = await matchOf(mineId, targetId);
    if (inserted) await endMatch(inserted, { id: mineId, account_id: Number(mine.account_id) });
    return { match: null };
  }

  if (won) {
    const deepLink = buildDeepLink(SPARK_APP, { matchId });
    pushQuietly(
      () =>
        channel.pushMany(
          [citizenid, target.citizenid],
          'match',
          { match_id: matchId },
          {
            notify: { type: 'info', title: 'Spark', message: 'New match' },
            kind: 'match',
            title: 'Spark',
            deepLink
          }
        ),
      'match'
    );
  }

  const row = await matchOf(mineId, targetId);
  return { match: row ? await toMatch(row, mine) : null };
});

app.registerEvent('matches', async (_source, _cbId, _data, citizenid) => {
  const mine = await liveProfileOf(citizenid);
  if (!mine || mine.status !== 'active') return [];
  const mineId = Number(mine.id);

  const rows =
    (await Database.query<MatchRow[]>(
      `SELECT \`id\`, \`profile_a\`, \`profile_b\`, \`created_at\` FROM \`${MATCHES}\`
       WHERE \`profile_a\` = ? OR \`profile_b\` = ?
       ORDER BY \`id\` DESC
       LIMIT ?`,
      [mineId, mineId, MATCHES_CAP]
    )) ?? [];
  const otherIds = rows.map((row) =>
    Number(row.profile_a) === mineId ? Number(row.profile_b) : Number(row.profile_a)
  );
  const cards = new Map(
    (await toCards(await activeProfiles(otherIds, Number(mine.account_id)))).map((card) => [
      card.id,
      card
    ])
  );
  const out: SparkMatch[] = [];
  rows.forEach((row, index) => {
    const card = cards.get(otherIds[index]);
    if (card) out.push({ id: Number(row.id), profile: card, created_at: row.created_at });
  });
  return out;
});

app.registerEvent('unmatch', async (_source, _cbId, data, citizenid) => {
  const mine = await liveProfileOf(citizenid);
  if (!mine) return false;
  const mineId = Number(mine.id);
  const match = await Database.single<MatchRow | null>(
    `SELECT \`id\`, \`profile_a\`, \`profile_b\`, \`created_at\` FROM \`${MATCHES}\`
     WHERE \`id\` = ? AND (\`profile_a\` = ? OR \`profile_b\` = ?) LIMIT 1`,
    [data.match_id, mineId, mineId]
  );
  if (!match) return false;
  const other = await endMatch(match, { id: mineId, account_id: Number(mine.account_id) });
  if (!other) return false;
  pushUnmatched(other, Number(match.id));
  return true;
});

/**
 * Block the account behind a profile, as `accounts:block` does (idempotent on the key), and end
 * any match with it. Like rows stay, so the pair never matches again even after an unblock.
 *
 * The block is written before the match is looked for, so a match a racing `swipe` inserts is
 * either seen here or sees the block itself (`swipe`'s re-check).
 */
app.registerEvent('block', async (_source, _cbId, data, citizenid) => {
  const mine = await requireActiveProfile(citizenid);
  const target = await reachableProfile(data.profile_id, mine);
  const mineId = Number(mine.id);

  try {
    await Database.insert(
      'INSERT INTO `mica_account_blocks` (`blocker_account_id`, `blocked_account_id`) VALUES (?, ?)',
      [Number(mine.account_id), Number(target.account_id)]
    );
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }

  const match = await matchOf(mineId, Number(target.id));
  let other: string | null = null;
  if (match) other = await endMatch(match, { id: mineId, account_id: Number(mine.account_id) });

  if (other && match) pushUnmatched(other, Number(match.id));
  return true;
});

// A phone in hand, server-side: each of these reaches another player (MICA-339).
app.requirePhoneFor('save', 'swipe', 'block');

/**
 * A block made through `accounts:block` ends a Spark match as Spark's own `block` does: the
 * match and its thread go, and the blocked side hears it silently. Run after the block row is
 * written, and on a block that already existed too, so a match already gone is a no-op. Any
 * profile status: a match on a taken-down profile is still a match the blocker wants ended.
 */
const endMatchesOnBlock = async (blocker: Account, blocked: Account): Promise<void> => {
  const rows = await Database.query<(MatchRow & { a_account: number })[]>(
    `SELECT m.\`id\`, m.\`profile_a\`, m.\`profile_b\`, m.\`created_at\`, pa.\`account_id\` AS a_account
     FROM \`${MATCHES}\` m
     JOIN \`${PROFILES}\` pa ON pa.\`id\` = m.\`profile_a\`
     JOIN \`${PROFILES}\` pb ON pb.\`id\` = m.\`profile_b\`
     WHERE (pa.\`account_id\` = ? AND pb.\`account_id\` = ?)
        OR (pa.\`account_id\` = ? AND pb.\`account_id\` = ?)`,
    [blocker.id, blocked.id, blocked.id, blocker.id]
  );
  for (const match of rows ?? []) {
    const blockerSide =
      Number(match.a_account) === Number(blocker.id)
        ? Number(match.profile_a)
        : Number(match.profile_b);
    const other = await endMatch(match, { id: blockerSide, account_id: Number(blocker.id) });
    if (other) pushUnmatched(other, Number(match.id));
  }
};

/**
 * Spark with the shared account and DM services (MICA-394): one account per citizen and none of
 * them in a directory (MICA-255), DMs only between matches, and a block that ends the match.
 */
defineSocialApp(SPARK_APP, {
  accounts: { maxPerCitizen: 1, listed: false },
  dms: sparkDms,
  onBlocked: endMatchesOnBlock
});

/**
 * A player's own delete (MICA-168) removes the profile first, the way `remove` does, so every
 * former match's thread goes and every former match hears of it. Registered, not imported by
 * `Privacy.ts`; a throw here aborts the purge before anything is deleted.
 */
onBeforeSelfServiceDelete(SPARK_APP, async (citizenid) => {
  await removeProfiles(citizenid);
});

// ---------------------------------------------------------------------------------------------
// The sweep: passes past `PASS_DAYS`, which keep nobody out of a deck any more
// ---------------------------------------------------------------------------------------------

export const SWEEP_INTERVAL_MS = 6 * 60 * 60_000;
/** Batches per run: a larger backlog drains over the next runs. */
export const SWEEP_MAX_BATCHES = 40;
const SWEEP_YIELD_MS = 50;

let sweeping = false;

/** Delete expired passes in bounded batches. Answers how many went; never throws. */
export const sweepSparkPasses = async (): Promise<number> => {
  if (sweeping) return 0;
  sweeping = true;
  let removed = 0;
  try {
    for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch += 1) {
      const rows = await Database.query<{ id: number }[]>(
        `SELECT \`id\` FROM \`${SWIPES}\`
         WHERE \`kind\` = 'pass' AND \`created_at\` < NOW() - INTERVAL ? DAY
         ORDER BY \`created_at\`, \`id\` LIMIT ${RETENTION_BATCH}`,
        [PASS_DAYS]
      );
      const ids = (Array.isArray(rows) ? rows : [])
        .map((row) => Number(row.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      if (ids.length === 0) break;
      // Asked again in the delete, so a pass turned into a like meanwhile stays.
      const result = await Database.query<{ affectedRows?: number }>(
        `DELETE FROM \`${SWIPES}\` WHERE \`id\` IN (${marks(ids)})
           AND \`kind\` = 'pass' AND \`created_at\` < NOW() - INTERVAL ? DAY`,
        [...ids, PASS_DAYS]
      );
      removed += Number(result?.affectedRows ?? 0) || 0;
      if (ids.length < RETENTION_BATCH) break;
      await new Promise<void>((resolve) => setTimeout(resolve, SWEEP_YIELD_MS));
    }
    if (removed > 0) console.log(`[spark] forgot ${removed} pass(es) past ${PASS_DAYS} days.`);
  } catch (error) {
    // The driver's last line only: an oxmysql error embeds the statement and its parameters.
    const line = reasonOf(error);
    console.error(`[spark] sweep failed: ${line}`);
  } finally {
    sweeping = false;
  }
  return removed;
};

let timer: ReturnType<typeof setInterval> | undefined;

/** Start the sweep: once now, then every `SWEEP_INTERVAL_MS`. Idempotent. */
export const startSparkSweep = (): void => {
  if (timer !== undefined) return;
  timer = setInterval(() => void sweepSparkPasses(), SWEEP_INTERVAL_MS);
  void sweepSparkPasses();
};

/** Tests only. */
export const __resetSparkSweep = (): void => {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  sweeping = false;
};

/** The resource-start hook, exported so a test can drive it. */
export const onSparkResourceStart = (resourceName: string): void => {
  if (resourceName !== GetCurrentResourceName()) return;
  whenSchemaReady(startSparkSweep);
};

on('onResourceStart', onSparkResourceStart);
