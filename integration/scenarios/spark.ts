// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { db } from '../lib/db';
import { call, invoke, pushes, seedPlayer, waitForPush, type PushEnvelope } from '../lib/door';
import { assert, unique } from '../lib/mica';
import { eventually, type Signal } from '../lib/wait';
import { schemaCreated } from './qbx';

/**
 * Spark (MICA-255, `server/services/Spark.ts`) inside a real FXServer on a real MariaDB, driven
 * through the integration door (MICA-397, `../lib/door.ts`): each action runs its own dispatch
 * as a synthetic player, so the deck's SQL, the swipe upsert, the match's unique pair key, the
 * block's either-way predicates and the DM policy all meet the real schema.
 *
 * Standalone only: `save`, `swipe`, `block` and `dms:send` are `requirePhoneFor` actions, and
 * the door's players hold no phone item, which only the standalone run (no `mica_phone_item`)
 * lets through.
 *
 * Every citizen is a fresh `unique()` one with its own gallery photo, inserted straight into
 * `mica_media` as the fixture `save` needs (a photo the caller owns and still has). Every
 * assertion is checked twice: against the reply, and against the table the reply came from.
 * Each scenario removes its profiles through `spark:remove` when it ends, pass or fail, so a
 * later deck read is not walking past this run's leftovers.
 */

const SPARK = 'spark';
const SWIPES = 'mica_spark_swipes';
const MATCHES = 'mica_spark_matches';

/** The deck's own ceiling (`DECK_PAGING.maxPageSize`), so a walk costs as few asks as it can. */
const DECK_PAGE = 20;

/** How far a deck walk goes looking for this run's profiles before it calls the deck wrong. */
const DECK_PAGES = 10;

/** A push the handler sends before it answers; the wait is only for the capture's own hop. */
const PUSH_WAIT_MS = 3_000;

/** Spark's shapes, as `shared/types.ts` declares them. Restated, not imported. */
interface SparkCard {
  id: number;
  account_id: number;
  display_name: string | null;
  age: number;
  bio: string | null;
  looking_for: string | null;
  photos: { id: number }[];
}
interface SparkProfile extends SparkCard {
  status: string;
  photo_ids: number[];
}
interface SparkMatch {
  id: number;
  profile: SparkCard;
}
interface DeckPage {
  rows: SparkCard[];
  nextCursor: number | null;
}

interface Dater {
  citizenid: string;
  name: string;
  profileId: number;
  accountId: number;
  photoId: number;
}

const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** Which honest path a reply took, printed beside the scenario's PASS. */
const branch = (id: string, text: string): void => {
  console.log(`[mica-integration] ${id}: ${text}`);
};

/**
 * Nothing Spark hands another player names a character: no `citizenid` key anywhere in it, and
 * none of the scenario's citizenids as a value either.
 */
const assertNoCitizen = (value: unknown, daters: readonly Dater[], what: string): void => {
  const text = show(value);
  assert(!text.includes('"citizenid"'), `${what} carries a citizenid key: ${text}`);
  for (const dater of daters) {
    assert(!text.includes(dater.citizenid), `${what} names ${dater.citizenid}: ${text}`);
  }
};

/** A photo in the citizen's own gallery: what `save` resolves `photo_id` against. */
const galleryPhoto = async (citizenid: string): Promise<number> =>
  await db.insert(
    'INSERT INTO `mica_media` (`citizenid`, `kind`, `url`, `mime_type`) ' +
      "VALUES (?, 'photo', 'https://example.invalid/spark.png', 'image/png')",
    [citizenid]
  );

/**
 * A synthetic player with a saved Spark profile on one gallery photo, checked against the reply
 * and the two rows `save` writes: the profile, and the one unlisted Spark account under it.
 */
const join = async (label: string, name: string, age: number): Promise<Dater> => {
  const citizenid = unique(label);
  await seedPlayer(citizenid, 0);
  const photoId = await galleryPhoto(citizenid);
  const { result } = await call<SparkProfile>(SPARK, 'save', citizenid, {
    display_name: name,
    age,
    bio: `${name} likes long drives up the Great Ocean Highway.`,
    looking_for: 'coffee',
    photos: [{ photo_id: photoId }]
  });
  assert(
    typeof result?.id === 'number' &&
      typeof result.account_id === 'number' &&
      result.status === 'active' &&
      result.display_name === name &&
      result.age === age &&
      result.photos.length === 1 &&
      show(result.photo_ids) === show([photoId]),
    `save for ${citizenid} answered ${show(result)}; expected an active profile named ${name}, ` +
      `aged ${age}, on gallery photo ${photoId}`
  );
  assertNoCitizen(result, [], `save's reply for ${citizenid}`);
  // The caller's own reply may name their own character no more than a card does.
  assert(!show(result).includes(citizenid), `save's reply names its own citizenid`);

  const row = await db.row(
    'SELECT `citizenid`, `account_id`, `age`, `status` FROM `mica_spark` WHERE `id` = ?',
    [result.id]
  );
  assert(
    row !== null &&
      String(row.citizenid) === citizenid &&
      Number(row.account_id) === result.account_id &&
      Number(row.age) === age &&
      String(row.status) === 'active',
    `mica_spark row ${result.id} holds ${show(row)}; expected ${citizenid}'s active profile on ` +
      `account ${result.account_id}`
  );
  const account = await db.row(
    'SELECT `citizenid`, `app`, `status` FROM `mica_accounts` WHERE `id` = ?',
    [result.account_id]
  );
  assert(
    account !== null &&
      String(account.citizenid) === citizenid &&
      String(account.app) === SPARK &&
      String(account.status) === 'active',
    `account ${result.account_id} holds ${show(account)}; expected ${citizenid}'s Spark account`
  );
  return { citizenid, name, profileId: result.id, accountId: result.account_id, photoId };
};

/** Remove each profile through the service, as a player would; a failure here is only logged. */
const leave = async (daters: readonly (Dater | undefined)[]): Promise<void> => {
  for (const dater of daters) {
    if (!dater) continue;
    try {
      await invoke(SPARK, 'remove', dater.citizenid, {});
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      console.log(`[mica-integration] spark: could not remove ${dater.citizenid}: ${why}`);
    }
  }
};

/**
 * The caller's deck, every page down to `floor` (the lowest profile id the scenario cares
 * about). Newest first by id, so this run's profiles sit at the top; a deck that has not reached
 * `floor` within `DECK_PAGES` pages is a deck ordered or paged wrong.
 */
const deckDownTo = async (who: Dater, floor: number): Promise<SparkCard[]> => {
  const cards: SparkCard[] = [];
  let cursor: number | null = null;
  for (let page = 0; page < DECK_PAGES; page += 1) {
    const payload: Record<string, unknown> =
      cursor === null ? { limit: DECK_PAGE } : { cursor, limit: DECK_PAGE };
    const { result } = await call<DeckPage>(SPARK, 'deck', who.citizenid, payload);
    assert(
      Array.isArray(result?.rows),
      `deck for ${who.citizenid} answered ${show(result)}; expected { rows, nextCursor }`
    );
    cards.push(...result.rows);
    if (result.nextCursor === null || result.nextCursor <= floor) return cards;
    cursor = result.nextCursor;
  }
  throw new Error(
    `the deck for ${who.citizenid} was still above profile ${floor} after ${DECK_PAGES} pages`
  );
};

const deckIds = async (who: Dater, floor: number): Promise<number[]> =>
  (await deckDownTo(who, floor)).map((card) => Number(card.id));

const swipe = async (who: Dater, target: Dater, verdict: 'like' | 'pass') => {
  const { result } = await call<{ match: SparkMatch | null }>(SPARK, 'swipe', who.citizenid, {
    profile_id: target.profileId,
    verdict
  });
  assert(
    result !== null && typeof result === 'object' && 'match' in result,
    `${who.name}'s ${verdict} on ${target.name} answered ${show(result)}; expected { match }`
  );
  return result;
};

const swipeKind = async (from: Dater, to: Dater): Promise<string[]> =>
  (
    await db.rows(
      `SELECT \`kind\` FROM \`${SWIPES}\` WHERE \`swiper_profile_id\` = ? AND \`target_profile_id\` = ?`,
      [from.profileId, to.profileId]
    )
  ).map((row) => String(row.kind));

const pairMatches = async (a: Dater, b: Dater): Promise<number[]> =>
  (
    await db.rows(
      `SELECT \`id\` FROM \`${MATCHES}\` WHERE \`profile_a\` = ? AND \`profile_b\` = ?`,
      [Math.min(a.profileId, b.profileId), Math.max(a.profileId, b.profileId)]
    )
  ).map((row) => Number(row.id));

const matchesOf = async (who: Dater): Promise<SparkMatch[]> => {
  const { result } = await call<SparkMatch[]>(SPARK, 'matches', who.citizenid, {});
  assert(Array.isArray(result), `matches for ${who.name} answered ${show(result)}`);
  return result;
};

/** DMs between two accounts, either direction: live ones, or with `all`, every row kept. */
const dmRows = async (a: Dater, b: Dater, all = false): Promise<number> =>
  await db.count(
    'SELECT COUNT(*) FROM `mica_blabber_dms` ' +
      'WHERE ((`from_account` = ? AND `to_account` = ?) OR (`from_account` = ? AND `to_account` = ?))' +
      (all ? '' : " AND `status` = 'active'"),
    [a.accountId, b.accountId, b.accountId, a.accountId]
  );

const isRefusal = (result: unknown, key: string): boolean =>
  result !== null &&
  typeof result === 'object' &&
  'error' in result &&
  (result as { key?: unknown }).key === key;

/**
 * Every envelope pushed to `who` until one matches, the match included: the caller can then
 * count what else arrived, which `waitForPush` drops.
 */
const collectUntil = async (
  who: Dater,
  match: (envelope: PushEnvelope) => boolean,
  signal: Signal,
  what: string
): Promise<PushEnvelope[]> => {
  const seen: PushEnvelope[] = [];
  await eventually(
    async () => {
      seen.push(...(await pushes(who.citizenid)));
      return seen.some(match) ? true : null;
    },
    PUSH_WAIT_MS,
    signal,
    what
  );
  return seen;
};

const isSpark = (envelope: PushEnvelope, event: string): boolean =>
  envelope.app === SPARK && envelope.event === event;

/** The match a swipe answered, or a throw naming what came back instead. */
const matchIn = (reply: { match: SparkMatch | null }, what: string): SparkMatch => {
  if (reply.match === null) throw new Error(`${what} answered ${show(reply)}; expected a match`);
  return reply.match;
};

/** Like each other: the second like wins the match. Answers the match id, checked twice. */
const mutualLike = async (first: Dater, second: Dater): Promise<number> => {
  const one = await swipe(first, second, 'like');
  assert(one.match === null, `${first.name}'s first like answered a match: ${show(one)}`);
  const two = matchIn(await swipe(second, first, 'like'), `${second.name}'s like back`);
  assert(
    two.profile.id === first.profileId,
    `${second.name}'s like back matched profile ${two.profile.id}; expected ${first.name}'s ` +
      `${first.profileId}`
  );
  const stored = await pairMatches(first, second);
  assert(
    stored.length === 1 && stored[0] === two.id,
    `mica_spark_matches holds ${show(stored)} for the pair; expected exactly [${two.id}]`
  );
  return two.id;
};

export const sparkScenarios: readonly Scenario[] = [
  {
    // MICA-255: a saved profile is in everyone else's deck and never in its owner's, and a card
    // carries no character: no citizenid key and no citizenid value, in the deck or in `mine`.
    id: 'spark-profiles-meet-in-each-others-deck',
    mode: 'standalone',
    tickets: ['MICA-255', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      let ada: Dater | undefined;
      let ben: Dater | undefined;
      try {
        ada = await join('spark_deck_a', 'Ada', 29);
        ben = await join('spark_deck_b', 'Ben', 31);
        const floor = Math.min(ada.profileId, ben.profileId);

        const adaDeck = await deckDownTo(ada, floor);
        const benDeck = await deckDownTo(ben, floor);
        const adaSees = adaDeck.find((card) => card.id === ben?.profileId);
        const benSees = benDeck.find((card) => card.id === ada?.profileId);
        assert(adaSees, `Ada's deck lacks Ben's profile ${ben.profileId}: ${show(adaDeck)}`);
        assert(benSees, `Ben's deck lacks Ada's profile ${ada.profileId}: ${show(benDeck)}`);
        assert(
          !adaDeck.some((card) => card.id === ada?.profileId),
          `Ada's deck holds her own profile ${ada.profileId}`
        );
        assert(
          !benDeck.some((card) => card.id === ben?.profileId),
          `Ben's deck holds his own profile ${ben.profileId}`
        );
        assert(
          adaSees?.display_name === 'Ben' &&
            adaSees.age === 31 &&
            adaSees.account_id === ben.accountId &&
            adaSees.photos.length === 1,
          `Ada's card for Ben reads ${show(adaSees)}; expected Ben, 31, account ${ben.accountId}`
        );
        assertNoCitizen(adaDeck, [ada, ben], "Ada's deck");
        assertNoCitizen(benDeck, [ada, ben], "Ben's deck");

        const { result: mine } = await call<SparkProfile | null>(SPARK, 'mine', ada.citizenid);
        assert(
          mine !== null && mine.id === ada.profileId && mine.status === 'active',
          `Ada's mine answered ${show(mine)}; expected her active profile ${ada.profileId}`
        );
        assertNoCitizen(mine, [ada, ben], "Ada's mine");
      } finally {
        await leave([ada, ben]);
      }
    }
  },
  {
    // MICA-255: a first like answers exactly as a pass does and tells nobody; only the like back
    // makes a match, stored once on the pair key, listed for both, and pushed to both once. A
    // like given again finds the same match and inserts no second row.
    id: 'spark-mutual-like-makes-one-match-and-tells-both',
    mode: 'standalone',
    tickets: ['MICA-255', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      let ada: Dater | undefined;
      let ben: Dater | undefined;
      try {
        ada = await join('spark_match_a', 'Ada', 27);
        ben = await join('spark_match_b', 'Ben', 28);
        const pair = [ada, ben];

        const first = await swipe(ada, ben, 'like');
        assert(first.match === null, `a one-sided like answered a match: ${show(first)}`);
        assert(
          show(await swipeKind(ada, ben)) === show(['like']),
          `Ada's swipe on Ben is stored as ${show(await swipeKind(ada, ben))}; expected ['like']`
        );
        assert(
          (await pairMatches(ada, ben)).length === 0,
          'a one-sided like left a row in mica_spark_matches'
        );
        // Drained now and counted below, so a push the first like sent would show there.
        const adaSeen = await pushes(ada.citizenid);
        const benSeen = await pushes(ben.citizenid);

        const back = matchIn(await swipe(ben, ada, 'like'), "Ben's like back");
        assert(
          back.profile.id === ada.profileId && back.profile.account_id === ada.accountId,
          `Ben's like back matched ${show(back)}; expected a match on Ada's profile`
        );
        assertNoCitizen(back, pair, "the like back's match");
        const matchId = back.id;
        const stored = await pairMatches(ada, ben);
        assert(
          stored.length === 1 && stored[0] === matchId,
          `mica_spark_matches holds ${show(stored)} for the pair; expected exactly [${matchId}]`
        );

        const isOurs = (envelope: PushEnvelope): boolean =>
          isSpark(envelope, 'match') && Number(envelope.payload?.match_id) === matchId;
        adaSeen.push(...(await collectUntil(ada, isOurs, signal, `Ada's match push ${matchId}`)));
        benSeen.push(...(await collectUntil(ben, isOurs, signal, `Ben's match push ${matchId}`)));
        for (const [name, seen] of [
          ['Ada', adaSeen],
          ['Ben', benSeen]
        ] as const) {
          const matchPushes = seen.filter((envelope) => isSpark(envelope, 'match'));
          assert(
            matchPushes.length === 1 && isOurs(matchPushes[0]),
            `${name} received ${show(matchPushes)}; expected exactly one match push for ${matchId}`
          );
          assertNoCitizen(matchPushes, pair, `${name}'s match push`);
        }

        const adaMatches = await matchesOf(ada);
        const benMatches = await matchesOf(ben);
        assert(
          adaMatches.some((m) => m.id === matchId && m.profile.id === ben?.profileId),
          `Ada's matches ${show(adaMatches)} lack match ${matchId} on Ben's profile`
        );
        assert(
          benMatches.some((m) => m.id === matchId && m.profile.id === ada?.profileId),
          `Ben's matches ${show(benMatches)} lack match ${matchId} on Ada's profile`
        );
        assertNoCitizen(adaMatches, pair, "Ada's matches");
        assertNoCitizen(benMatches, pair, "Ben's matches");

        const again = await swipe(ada, ben, 'like');
        assert(
          again.match?.id === matchId,
          `Ada's second like answered ${show(again)}; expected the same match ${matchId}`
        );
        const after = await pairMatches(ada, ben);
        assert(
          after.length === 1 && after[0] === matchId,
          `a repeated like left ${show(after)} in mica_spark_matches; expected [${matchId}]`
        );
        const repeat = (await pushes(ben.citizenid)).filter((e) => isSpark(e, 'match'));
        assert(repeat.length === 0, `a repeated like pushed Ben ${show(repeat)}`);
      } finally {
        await leave([ada, ben]);
      }
    }
  },
  {
    // MICA-255: a pass takes the profile out of the passer's deck and not out of the other's —
    // the deck says nothing about who passed on you. A second pass is an upsert onto the same
    // row; a like replaces a pass; and a pass after a like is refused silently, the row staying
    // a like, since a like is what stops an unmatched pair matching again.
    id: 'spark-pass-leaves-the-deck-and-a-like-is-never-taken-back',
    mode: 'standalone',
    tickets: ['MICA-255', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      const id = 'spark-pass-leaves-the-deck-and-a-like-is-never-taken-back';
      let ada: Dater | undefined;
      let ben: Dater | undefined;
      try {
        ada = await join('spark_pass_a', 'Ada', 33);
        ben = await join('spark_pass_b', 'Ben', 34);
        const floor = Math.min(ada.profileId, ben.profileId);
        assert(
          (await deckIds(ada, floor)).includes(ben.profileId),
          `Ben's profile ${ben.profileId} is not in Ada's deck before any swipe`
        );

        for (const attempt of ['first', 'second']) {
          const passed = await swipe(ada, ben, 'pass');
          assert(passed.match === null, `the ${attempt} pass answered ${show(passed)}`);
          const kinds = await swipeKind(ada, ben);
          assert(
            show(kinds) === show(['pass']),
            `after the ${attempt} pass Ada's swipes on Ben are ${show(kinds)}; expected ['pass']`
          );
        }
        branch(id, 'a second pass on the same profile is accepted and upserts the one row');

        const adaDeck = await deckIds(ada, floor);
        assert(
          !adaDeck.includes(ben.profileId),
          `Ben's profile ${ben.profileId} is still in Ada's deck after her pass: ${show(adaDeck)}`
        );
        const benDeck = await deckIds(ben, floor);
        assert(
          benDeck.includes(ada.profileId),
          `Ada's pass on Ben took her profile ${ada.profileId} out of Ben's deck: ${show(benDeck)}`
        );

        const liked = await swipe(ada, ben, 'like');
        assert(liked.match === null, `a like over a pass answered ${show(liked)}`);
        assert(
          show(await swipeKind(ada, ben)) === show(['like']),
          `a like over a pass is stored as ${show(await swipeKind(ada, ben))}; expected ['like']`
        );

        const retract = await swipe(ada, ben, 'pass');
        assert(retract.match === null, `a pass over a like answered ${show(retract)}`);
        assert(
          show(await swipeKind(ada, ben)) === show(['like']),
          `a pass over a like is stored as ${show(await swipeKind(ada, ben))}; the like must stay`
        );
        assert(
          !(await deckIds(ada, floor)).includes(ben.profileId),
          `Ben's profile ${ben.profileId} came back into Ada's deck after she liked him`
        );
        assert(
          (await pairMatches(ada, ben)).length === 0,
          'a one-sided like and passes left a row in mica_spark_matches'
        );
      } finally {
        await leave([ada, ben]);
      }
    }
  },
  {
    // MICA-255: a block ends the match (row gone, the other side told silently) and hides each
    // from the other's deck and matches, either way; its positive twin is a third profile both
    // still see. A swipe across the block gets the one generic refusal.
    id: 'spark-block-dissolves-the-match-and-hides-both-ways',
    mode: 'standalone',
    tickets: ['MICA-255', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      let ada: Dater | undefined;
      let ben: Dater | undefined;
      let cal: Dater | undefined;
      try {
        ada = await join('spark_block_a', 'Ada', 40);
        ben = await join('spark_block_b', 'Ben', 41);
        cal = await join('spark_block_c', 'Cal', 42);
        const floor = Math.min(ada.profileId, ben.profileId, cal.profileId);
        const matchId = await mutualLike(ada, ben);
        await pushes(ada.citizenid);
        await pushes(ben.citizenid);

        const { result: blocked } = await call<boolean>(SPARK, 'block', ada.citizenid, {
          profile_id: ben.profileId
        });
        assert(blocked === true, `Ada's block on Ben answered ${show(blocked)}; expected true`);
        assert(
          (await db.count(
            'SELECT COUNT(*) FROM `mica_account_blocks` ' +
              'WHERE `blocker_account_id` = ? AND `blocked_account_id` = ?',
            [ada.accountId, ben.accountId]
          )) === 1,
          `mica_account_blocks holds no block from account ${ada.accountId} on ${ben.accountId}`
        );
        const left = await pairMatches(ada, ben);
        assert(left.length === 0, `the block left ${show(left)} in mica_spark_matches`);

        const told = await waitForPush(
          ben.citizenid,
          (envelope) =>
            isSpark(envelope, 'unmatched') && Number(envelope.payload?.match_id) === matchId,
          PUSH_WAIT_MS,
          signal,
          `Ben's unmatched push for match ${matchId}`
        );
        assertNoCitizen(told, [ada, ben, cal], "Ben's unmatched push");

        for (const [who, other] of [
          [ada, ben],
          [ben, ada]
        ] as const) {
          const deck = await deckIds(who, floor);
          assert(
            !deck.includes(other.profileId),
            `${who.name}'s deck still holds ${other.name}'s profile ${other.profileId} across ` +
              `the block: ${show(deck)}`
          );
          assert(
            deck.includes(cal.profileId),
            `${who.name}'s deck lost Cal's profile ${cal.profileId}, whom nobody blocked: ` +
              show(deck)
          );
          const listed = await matchesOf(who);
          assert(
            !listed.some((m) => m.id === matchId || m.profile.id === other.profileId),
            `${who.name}'s matches still list ${other.name} after the block: ${show(listed)}`
          );
        }

        const across = await invoke(SPARK, 'swipe', ben.citizenid, {
          profile_id: ada.profileId,
          verdict: 'like'
        });
        assert(
          isRefusal(across.result, 'server.spark.gone'),
          `Ben's swipe on Ada across her block answered ${show(across.result)}; expected the ` +
            "'server.spark.gone' refusal"
        );
        const twin = await swipe(ben, cal, 'pass');
        assert(twin.match === null, `Ben's pass on Cal answered ${show(twin)}`);
      } finally {
        await leave([ada, ben, cal]);
      }
    }
  },
  {
    // MICA-255, MICA-394: Spark's DMs ride the shared `dms` service under Spark's policy — a
    // message between matched accounts is sent, stored and pushed on Spark's channel; one to an
    // account Spark never matched is refused in the same words as a block and writes nothing;
    // and an unmatch deletes the thread and closes it again.
    id: 'spark-dms-only-between-matches',
    mode: 'standalone',
    tickets: ['MICA-255', 'MICA-394', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      let ada: Dater | undefined;
      let ben: Dater | undefined;
      let cal: Dater | undefined;
      try {
        ada = await join('spark_dm_a', 'Ada', 25);
        ben = await join('spark_dm_b', 'Ben', 26);
        cal = await join('spark_dm_c', 'Cal', 27);
        const matchId = await mutualLike(ada, ben);
        await pushes(ben.citizenid);

        const send = (from: Dater, to: Dater, body: string) =>
          invoke<unknown>('dms', 'send', from.citizenid, {
            app: SPARK,
            account_id: from.accountId,
            peer_account_id: to.accountId,
            body
          });

        const sent = await send(ada, ben, 'Coffee at Bean Machine?');
        const message = sent.result as { id?: unknown; to_account?: unknown } | null;
        assert(
          typeof message?.id === 'number' && message.to_account === ben.accountId,
          `a DM between matched accounts answered ${show(sent.result)}; expected the new message`
        );
        assert(
          (await dmRows(ada, ben)) === 1,
          `mica_blabber_dms holds ${await dmRows(ada, ben)} rows for the matched pair; expected 1`
        );
        const dm = await waitForPush(
          ben.citizenid,
          (envelope) =>
            isSpark(envelope, 'dm') && Number(envelope.payload?.peer_account_id) === ada?.accountId,
          PUSH_WAIT_MS,
          signal,
          "Ben's Spark dm push from Ada's account"
        );
        assertNoCitizen(dm, [ada, ben, cal], "Ben's dm push");
        assert(
          !show(dm).includes('Bean Machine'),
          `the dm push carries the message text: ${show(dm)}`
        );

        const stranger = await send(ada, cal, 'Hi there');
        assert(
          isRefusal(stranger.result, 'server.blabberDms.blocked'),
          `a DM to an unmatched Spark account answered ${show(stranger.result)}; expected the ` +
            "'server.blabberDms.blocked' refusal"
        );
        assert(
          (await dmRows(ada, cal)) === 0,
          `a refused DM left ${await dmRows(ada, cal)} rows between Ada and Cal`
        );

        const { result: unmatched } = await call<boolean>(SPARK, 'unmatch', ben.citizenid, {
          match_id: matchId
        });
        assert(unmatched === true, `Ben's unmatch answered ${show(unmatched)}; expected true`);
        assert((await pairMatches(ada, ben)).length === 0, 'the unmatch left the match row');
        assert(
          (await dmRows(ada, ben)) === 0,
          `the unmatch left ${await dmRows(ada, ben)} live DMs between Ada and Ben; expected 0`
        );
        // Deleted, not removed (MICA-428): the thread is kept for staff.
        assert(
          (await dmRows(ada, ben, true)) === 1,
          `the unmatch kept ${await dmRows(ada, ben, true)} DM rows between Ada and Ben; expected 1`
        );
        const after = await send(ada, ben, 'Still there?');
        assert(
          isRefusal(after.result, 'server.blabberDms.blocked'),
          `a DM after the unmatch answered ${show(after.result)}; expected the ` +
            "'server.blabberDms.blocked' refusal"
        );
        assert(
          (await dmRows(ada, ben, true)) === 1,
          `a refused DM after the unmatch wrote ${(await dmRows(ada, ben, true)) - 1} rows`
        );
      } finally {
        await leave([ada, ben, cal]);
      }
    }
  }
];
