// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const transport = vi.hoisted(() => ({ fetchNui: vi.fn() }));
vi.mock('../nui/fetchNui', () => ({ fetchNui: transport.fetchNui }));

import {
  getMyAccounts,
  getAccounts,
  getFollowStats,
  followAccount,
  getReactionsFor
} from './accounts';

// Braces, not an expression body: a function returned from `beforeEach` is run as its
// teardown, and `mockReset()` returns the mock — which would then be called after every case.
beforeEach(() => {
  transport.fetchNui.mockReset();
});

/**
 * A refused request, answered the way the real `fetchNui` answers one: the default when the
 * caller asked for one, a throw when it did not. `mockRejectedValue` would skip the defaulting
 * and pass against the very reads this file pins (MICA-384).
 */
const refuse = (_event: string, _data?: unknown, options?: { defaultValue?: unknown }) =>
  options?.defaultValue !== undefined
    ? Promise.resolve(options.defaultValue)
    : Promise.reject(new Error('Player not authenticated'));

// Every custom action here is contracted, so the transport sees the generic `svc`
// envelope rather than a named route (MICA-213).
describe('accounts service', () => {
  it('getMyAccounts asks by app, with no default to fall back on', async () => {
    transport.fetchNui.mockResolvedValueOnce({ rows: [], limit: 3 });
    await expect(getMyAccounts('blabber')).resolves.toEqual({ rows: [], limit: 3 });
    expect(transport.fetchNui).toHaveBeenCalledWith('svc', {
      service: 'accounts',
      action: 'mine',
      data: { app: 'blabber' }
    });
  });

  it('followAccount posts the app and both ids', async () => {
    transport.fetchNui.mockResolvedValueOnce(undefined);
    await followAccount({ app: 'blabber', follower_account_id: 1, followee_account_id: 2 });
    expect(transport.fetchNui).toHaveBeenCalledWith('svc', {
      service: 'accounts',
      action: 'follow',
      data: {
        app: 'blabber',
        follower_account_id: 1,
        followee_account_id: 2
      }
    });
  });

  it('getReactionsFor asks by app, table and ids', async () => {
    transport.fetchNui.mockResolvedValueOnce({});
    await getReactionsFor({ app: 'blabber', target_table: 'mica_blabs', target_ids: [1] });
    expect(transport.fetchNui).toHaveBeenCalledWith('svc', {
      service: 'accounts',
      action: 'reactionsFor',
      data: { app: 'blabber', target_table: 'mica_blabs', target_ids: [1] }
    });
  });
});

/**
 * MICA-384. Each of these answered empty or zero on failure, which is what a real "nothing"
 * looks like: a player who already holds a handle was offered to claim their first, real
 * follower counts were overwritten with zeros, and a failed reaction read wiped every chip.
 */
describe('a failed accounts read rejects rather than answering nothing', () => {
  const target = { app: 'blabber', target_table: 'mica_blabs', target_ids: [1] };
  const stats = { app: 'blabber', account_id: 7 };

  it.each([
    ['getMyAccounts', () => getMyAccounts('blabber')],
    ['getAccounts', () => getAccounts({ app: 'blabber', handle: 'ada' })],
    ['getFollowStats', () => getFollowStats(stats)],
    ['getReactionsFor', () => getReactionsFor(target)]
  ])('%s, on a refused request', async (_name, read) => {
    transport.fetchNui.mockImplementation(refuse);
    await expect(read()).rejects.toThrow();
  });

  it.each([
    ['getMyAccounts', () => getMyAccounts('blabber')],
    ['getAccounts', () => getAccounts({ app: 'blabber', handle: 'ada' })],
    ['getFollowStats', () => getFollowStats(stats)],
    ['getReactionsFor', () => getReactionsFor(target)]
  ])('%s, on a reply with nothing in it', async (_name, read) => {
    transport.fetchNui.mockResolvedValue(null);
    await expect(read()).rejects.toThrow();
  });

  it('getFollowStats takes a real answer', async () => {
    const answer = { followers: 4, following: 2, followedByMe: true, blockedByMe: false };
    transport.fetchNui.mockResolvedValue(answer);
    await expect(getFollowStats(stats)).resolves.toEqual(answer);
  });

  it('getAccounts takes a real empty answer as empty', async () => {
    transport.fetchNui.mockResolvedValue({ rows: [] });
    await expect(getAccounts({ app: 'blabber', handle: 'nobody' })).resolves.toEqual({
      rows: []
    });
  });
});
