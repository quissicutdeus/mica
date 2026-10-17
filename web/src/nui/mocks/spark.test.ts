// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-255: Spark's mocks keep the server's rules — no deck without your own profile, the deck
 * leaves out you, anyone you swiped, blocks either way and deleted profiles, a match only on a
 * mutual like, and one sentence for every profile out of reach — and `dms` serves a 'spark'
 * thread only between matched accounts. Fresh modules per case: every table is module scope.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MockHandler } from './registry';

let spark: Record<string, MockHandler>;
let dms: Record<string, MockHandler>;
let reports: Record<string, MockHandler>;
let SEED: typeof import('./spark').SPARK_SEED;
let ME: number;
let GONE: string;
let OPENER: string;

beforeEach(async () => {
  vi.resetModules();
  spark = (await import('./services/spark')).mocks;
  dms = (await import('./services/dms')).mocks;
  reports = (await import('./services/reports')).mocks;
  ({
    SPARK_SEED: SEED,
    SPARK_ME: ME,
    SPARK_GONE: GONE,
    SPARK_OPENER: OPENER
  } = await import('./spark'));
});

const PROFILE = {
  display_name: 'Ada',
  age: 29,
  bio: 'hi',
  looking_for: null,
  photos: [{ photo_id: 1 }]
};

const optIn = () => spark['spark:save'](PROFILE);
const deckIds = async () =>
  ((await spark['spark:deck']({})) as { rows: { id: number }[] }).rows.map((r) => r.id);

describe('spark mocks', () => {
  it('starts with no profile, and refuses the deck until there is one', async () => {
    expect(await spark['spark:mine']({})).toBeNull();
    expect(() => spark['spark:deck']({})).toThrow(/profile first/);
    expect(await spark['spark:matches']({})).toEqual([]);
  });

  it('saves a profile onto the Spark account, then edits it in place', async () => {
    const first = await optIn();
    expect(first).toMatchObject({ account_id: ME, display_name: 'Ada', age: 29, photo_ids: [1] });
    expect(first.photos).toHaveLength(1);
    // The photo's id is Spark's own row, and the gallery's id is not on the media.
    expect(first.photos[0].id).not.toBe(1);
    expect(first.photos[0].media).not.toHaveProperty('id');
    expect(first.photos[0].media).not.toHaveProperty('citizenid');

    const edited = await spark['spark:save']({ ...PROFILE, display_name: 'Ada L', age: 30 });
    expect(edited.id).toBe(first.id);
    expect(await spark['spark:mine']({})).toMatchObject({ display_name: 'Ada L', age: 30 });
  });

  it.each([
    [{ age: 17 }, /18/],
    [{ age: 100 }, /99/],
    [{ display_name: ' ' }, /name/],
    [{ display_name: 'x'.repeat(33) }, /name/],
    [{ photos: [] }, /photos/],
    [{ photos: [1, 2, 3, 4, 5].map((photo_id) => ({ photo_id })) }, /photos/],
    [{ photos: [{ photo_id: 99999 }] }, /gallery/],
    [{ bio: 'x'.repeat(301) }, /bio/],
    [{ looking_for: 'x'.repeat(61) }, /looking/]
  ])('refuses %o', (patch, message) => {
    expect(() => spark['spark:save']({ ...PROFILE, ...patch })).toThrow(message);
  });

  it('deals Maya then Jordan: never me, never the blocked Casey, no card data beyond the card', async () => {
    await optIn();
    expect(await deckIds()).toEqual([SEED.maya.profile, SEED.jordan.profile]);
    const page = (await spark['spark:deck']({})) as { rows: object[] };
    for (const card of page.rows) {
      expect(Object.keys(card).sort()).toEqual(
        ['account_id', 'age', 'bio', 'display_name', 'id', 'looking_for', 'photos'].sort()
      );
    }
  });

  it('pages the deck on the last id delivered', async () => {
    await optIn();
    const first = await spark['spark:deck']({ limit: 1 });
    expect(first.rows.map((r: { id: number }) => r.id)).toEqual([SEED.maya.profile]);
    expect(first.nextCursor).toBe(SEED.maya.profile);
    const second = await spark['spark:deck']({ cursor: first.nextCursor, limit: 1 });
    expect(second.rows.map((r: { id: number }) => r.id)).toEqual([SEED.jordan.profile]);
    expect(second.nextCursor).toBeNull();
  });

  it('answers the first like with nothing, exactly as a pass', async () => {
    await optIn();
    expect(
      await spark['spark:swipe']({ profile_id: SEED.jordan.profile, verdict: 'like' })
    ).toEqual({ match: null });
    expect(await deckIds()).toEqual([SEED.maya.profile]);
    expect(await spark['spark:matches']({})).toEqual([]);
  });

  it('matches on the mutual like, with one message from Maya in the thread', async () => {
    await optIn();
    const { match } = await spark['spark:swipe']({
      profile_id: SEED.maya.profile,
      verdict: 'like'
    });
    expect(match).toMatchObject({ profile: { id: SEED.maya.profile, display_name: 'Maya' } });
    expect(match.profile).not.toHaveProperty('photo_ids');
    expect(await spark['spark:matches']({})).toEqual([match]);

    const threads = await dms['dms:threads']({ app: 'spark' });
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ peer_account_id: SEED.maya.account, unread: 1 });
    const page = await dms['dms:get']({
      app: 'spark',
      account_id: ME,
      peer_account_id: SEED.maya.account
    });
    expect(page.rows.map((m: { body: string }) => m.body)).toEqual([OPENER]);
    const sent = await dms['dms:send']({
      app: 'spark',
      account_id: ME,
      peer_account_id: SEED.maya.account,
      body: 'hey you'
    });
    expect(sent).toMatchObject({ from_account: ME, to_account: SEED.maya.account });
  });

  it('serves no thread without a match, and none after an unmatch', async () => {
    await optIn();
    const send = (peer: number) =>
      dms['dms:send']({ app: 'spark', account_id: ME, peer_account_id: peer, body: 'hi' });
    expect(() => send(SEED.jordan.account)).toThrow(/can't message/);

    const { match } = await spark['spark:swipe']({
      profile_id: SEED.maya.profile,
      verdict: 'like'
    });
    expect(await spark['spark:unmatch']({ match_id: match.id })).toBe(true);
    expect(await spark['spark:matches']({})).toEqual([]);
    expect(await dms['dms:threads']({ app: 'spark' })).toEqual([]);
    expect(() => send(SEED.maya.account)).toThrow(/can't message/);
    expect(() =>
      dms['dms:get']({ app: 'spark', account_id: ME, peer_account_id: SEED.maya.account })
    ).toThrow(/can't message/);
  });

  it('answers the same sentence for me, a blocked profile, a deleted one and no such one', async () => {
    await optIn();
    const mine = (await spark['spark:mine']({})).id;
    for (const profile_id of [mine, SEED.casey.profile, 4242]) {
      expect(() => spark['spark:swipe']({ profile_id, verdict: 'like' })).toThrow(GONE);
      expect(() => spark['spark:block']({ profile_id })).toThrow(GONE);
    }
  });

  it('blocks: unmatched, out of the deck, and the thread gone', async () => {
    await optIn();
    const { match } = await spark['spark:swipe']({
      profile_id: SEED.maya.profile,
      verdict: 'like'
    });
    expect(await spark['spark:block']({ profile_id: SEED.maya.profile })).toBe(true);
    expect(await spark['spark:matches']({})).toEqual([]);
    expect(await dms['dms:threads']({ app: 'spark' })).toEqual([]);
    expect(match.id).toBeGreaterThan(0);
    expect(() => spark['spark:swipe']({ profile_id: SEED.maya.profile, verdict: 'like' })).toThrow(
      GONE
    );
  });

  it('remove deletes the profile, swipes and matches, and leaves the deck refused', async () => {
    await optIn();
    await spark['spark:swipe']({ profile_id: SEED.maya.profile, verdict: 'like' });
    expect(await spark['spark:remove']({})).toBe(true);
    expect(await spark['spark:mine']({})).toBeNull();
    expect(await spark['spark:matches']({})).toEqual([]);
    expect(() => spark['spark:deck']({})).toThrow(/profile first/);
    // Maya's like went with it: a fresh profile liking her is no longer a match.
    await optIn();
    expect(await spark['spark:swipe']({ profile_id: SEED.maya.profile, verdict: 'like' })).toEqual({
      match: null
    });
  });

  it('brings a passed profile back after fourteen days', async () => {
    await optIn();
    await spark['spark:swipe']({ profile_id: SEED.jordan.profile, verdict: 'pass' });
    expect(await deckIds()).toEqual([SEED.maya.profile]);
    vi.useFakeTimers({ now: Date.now() + 15 * 24 * 60 * 60 * 1000 });
    try {
      expect(await deckIds()).toEqual([SEED.maya.profile, SEED.jordan.profile]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues a report on a profile and on a message, and refuses one on my own', async () => {
    const queue = async () =>
      (await reports['reports:queue']({})) as { target_table: string; target_preview?: string }[];
    const file = (targetTable: string, targetId: number) =>
      reports['reports:create']({ targetTable, targetId, category: 'harassment' });
    expect(await queue()).toHaveLength(1);

    await file('mica_spark', SEED.jordan.profile);
    const mine = await optIn();
    await expect(file('mica_spark', mine.id)).rejects.toThrow(/your own/);
    await expect(file('mica_spark', 4242)).rejects.toThrow(/no longer exists/);

    await spark['spark:swipe']({ profile_id: SEED.maya.profile, verdict: 'like' });
    const thread = await dms['dms:get']({
      app: 'spark',
      account_id: ME,
      peer_account_id: SEED.maya.account
    });
    await file('mica_blabber_dms', thread.rows[0].id);
    const sent = await dms['dms:send']({
      app: 'spark',
      account_id: ME,
      peer_account_id: SEED.maya.account,
      body: 'mine'
    });
    await expect(file('mica_blabber_dms', sent.id)).rejects.toThrow(/your own/);

    const queued = await queue();
    expect(queued).toHaveLength(3);
    expect(queued.slice(1)).toMatchObject([
      { target_table: 'mica_spark', target_preview: expect.stringContaining('Mechanic') },
      { target_table: 'mica_blabber_dms', target_preview: OPENER }
    ]);
    for (const report of queued.slice(1)) expect(report).not.toHaveProperty('reporter_label');
  });
});
