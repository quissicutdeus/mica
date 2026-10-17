// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-253: Glimpse's mocks answer the contract's shapes, and the accounts mock reads the app
 * each request names instead of assuming Blabber. Fresh modules per case, since every table
 * here is module scope and a case that likes or removes something would leak into the next.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MockHandler } from './registry';

let glimpse: Record<string, MockHandler>;
let comments: Record<string, MockHandler>;
let accounts: Record<string, MockHandler>;

beforeEach(async () => {
  vi.resetModules();
  glimpse = (await import('./services/glimpse')).mocks;
  comments = (await import('./services/glimpse_comments')).mocks;
  accounts = (await import('./services/accounts')).mocks;
});

/** The player's Glimpse account in the fixture, and two that are not theirs. */
const ME = 20;
const LENA = 21;

describe('glimpse mocks', () => {
  it('opens a feed of twelve, newest first, with photos and never a citizenid', async () => {
    const page = await glimpse['glimpse:feed']({});
    expect(page.rows.map((p: { id: number }) => p.id)).toEqual([
      12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1
    ]);
    expect(page.nextCursor).toBeNull();
    for (const post of page.rows) {
      expect(post).not.toHaveProperty('citizenid');
      expect(post.attachments.length).toBeGreaterThan(0);
      for (const att of post.attachments) {
        expect(att.media.kind).toBe('photo');
        expect(att.media).not.toHaveProperty('citizenid');
      }
    }
  });

  it('pages on the last id delivered', async () => {
    const first = await glimpse['glimpse:feed']({ limit: 5 });
    expect(first.nextCursor).toBe(8);
    const second = await glimpse['glimpse:feed']({ cursor: first.nextCursor, limit: 5 });
    expect(second.rows[0].id).toBe(7);
  });

  it('creates from an owned account and a real photo, and refuses a post with none', async () => {
    const created = await glimpse['glimpse:create']({
      account_id: ME,
      caption: ' hi ',
      attachments: [{ photo_id: 1 }]
    });
    expect(created).toMatchObject({
      account_id: ME,
      caption: 'hi',
      handle: 'ada',
      editWindow: 900
    });
    expect(created.attachments).toHaveLength(1);
    expect(() =>
      glimpse['glimpse:create']({ account_id: ME, attachments: [{ photo_id: 999_999 }] })
    ).toThrow();
    // Not the player's, and a Blabber account is not a Glimpse one even though it is owned.
    expect(() =>
      glimpse['glimpse:create']({ account_id: LENA, attachments: [{ photo_id: 1 }] })
    ).toThrow();
    expect(() =>
      glimpse['glimpse:create']({ account_id: 1, attachments: [{ photo_id: 1 }] })
    ).toThrow();
  });

  it('answers a profile with its account, and comment counts by post', async () => {
    const profile = await glimpse['glimpse:profile']({ account_id: ME });
    expect(profile.account.handle).toBe('ada');
    expect(profile.rows.every((p: { account_id: number }) => p.account_id === ME)).toBe(true);
    expect(profile.rows.length).toBeGreaterThan(0);
    expect(await glimpse['glimpse:engagement']({ ids: [12, 1] })).toEqual({
      12: { comments: 2 },
      1: { comments: 0 }
    });
  });
});

describe('glimpse_comments mocks', () => {
  it('lets the post owner remove a comment they did not write', async () => {
    // Comment 1 is @lens_lena's, on post 12, which is the player's.
    expect(await comments['glimpse_comments:remove']({ account_id: ME, id: 1 })).toBe(true);
    const page = await comments['glimpse_comments:list']({ post_id: 12 });
    expect(page.rows.map((c: { id: number }) => c.id)).toEqual([2]);
  });

  it('refuses a stranger removing a comment on somebody else’s post', async () => {
    // Comment 4 is @lens_lena's on @nightowl's post 10: the player is neither.
    expect(() => comments['glimpse_comments:remove']({ account_id: ME, id: 4 })).toThrow();
  });

  it('posts a comment that the list then returns first', async () => {
    const created = await comments['glimpse_comments:create']({
      account_id: ME,
      post_id: 1,
      body: 'nice'
    });
    expect(created).toMatchObject({ post_id: 1, account_id: ME, body: 'nice', handle: 'ada' });
    const page = await comments['glimpse_comments:list']({ post_id: 1 });
    expect(page.rows[0].id).toBe(created.id);
  });
});

describe('the accounts mock reads the app', () => {
  it('answers mine per app', async () => {
    const blabber = await accounts['accounts:mine']({ app: 'blabber' });
    const glimpseMine = await accounts['accounts:mine']({ app: 'glimpse' });
    expect(blabber.rows.map((a: { id: number }) => a.id)).toEqual([1, 4]);
    expect(glimpseMine.rows.map((a: { id: number }) => a.id)).toEqual([ME]);
  });

  it('lets a handle taken in one app be claimed in another', async () => {
    expect(() => accounts['accounts:create']({ app: 'glimpse', handle: 'ada' })).toThrow();
    const created = await accounts['accounts:create']({ app: 'glimpse', handle: 'ada_alt' });
    expect(created.app).toBe('glimpse');
  });

  it('seeds ❤️ on Glimpse posts and counts the player’s as mine', async () => {
    const out = await accounts['accounts:reactionsFor']({
      app: 'glimpse',
      target_table: 'mica_glimpse',
      target_ids: [12, 11, 1]
    });
    expect(out[12]).toEqual({ counts: { '❤️': 2 }, mine: [] });
    expect(out[11]).toEqual({ counts: { '❤️': 1 }, mine: ['❤️'] });
    expect(out[1]).toEqual({ counts: {}, mine: [] });
  });

  it('likes with ❤️ only, toggling the count', async () => {
    const like = { app: 'glimpse', account_id: ME, target_table: 'mica_glimpse', target_id: 12 };
    expect(() => accounts['accounts:react']({ ...like, emoji: '😂' })).toThrow();
    expect(await accounts['accounts:react']({ ...like, emoji: '❤️' })).toBe(true);
    const after = await accounts['accounts:reactionsFor']({
      app: 'glimpse',
      target_table: 'mica_glimpse',
      target_ids: [12]
    });
    expect(after[12]).toEqual({ counts: { '❤️': 3 }, mine: ['❤️'] });
    expect(await accounts['accounts:unreact']({ ...like, emoji: '❤️' })).toBe(true);
  });

  it('still lets Blabber react with any emoji', async () => {
    expect(
      await accounts['accounts:react']({
        app: 'blabber',
        account_id: 1,
        target_table: 'mica_blabber_dms',
        target_id: 1,
        emoji: '😂'
      })
    ).toBe(true);
  });
});
