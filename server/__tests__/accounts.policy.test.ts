// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, handlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };

  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

const bridge = vi.hoisted(() => ({ current: 'CIT_A' }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.current, source: 5, setMeta: () => {} }),
    getCitizenId: () => bridge.current,
    registerUsableItem: () => {},
    getSourceByCitizenId: () => null
  }
}));

import { onAccountBlocked, registerAccountAppPolicy, scrubAccount } from '../services/Accounts';

/**
 * Per-app account policy (MICA-255): a cap other than the convar's, and an app whose accounts
 * are in no directory. Registered here the way an app's own service file would, under ids no
 * real app has, so this suite never depends on Spark existing.
 *
 * Its own file because the registry is module state: `accounts.test.ts` pins the behaviour
 * with no policy registered at all, which includes the generic `get`'s SQL being byte-identical
 * to the base repository's.
 */
const UNLISTED = 'unlisted_app';
const CAPPED = 'capped_app';
registerAccountAppPolicy(UNLISTED, { maxPerCitizen: 1, listed: false });
registerAccountAppPolicy(CAPPED, { maxPerCitizen: 2 });

const blockHandler = vi.fn(async (_blocker: unknown, _blocked: unknown) => {});
onAccountBlocked(UNLISTED, blockHandler);

const call = async (action: string, data: unknown, citizenid = 'CIT_A') => {
  const handler = handlers.get(`mica:server:accounts:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);

  bridge.current = citizenid;
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls[0]?.[3];
};

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ');

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(7);
  dbMock.update.mockResolvedValue(true);
  dbMock.single.mockResolvedValue(null);
  dbMock.scalar.mockResolvedValue(0);
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
});

describe('registering a policy', () => {
  it('throws on a second registration for the same app', () => {
    expect(() => registerAccountAppPolicy(CAPPED, { maxPerCitizen: 5 })).toThrow(
      /already has an account policy/
    );
  });

  it('throws on an id that is not an app id', () => {
    expect(() => registerAccountAppPolicy('Not An App', {})).toThrow(/not an app id/);
  });

  it.each([0, -1, 1.5, Number.NaN])('throws on a cap of %s', (cap) => {
    expect(() =>
      registerAccountAppPolicy(`cap_${String(cap).length}`, { maxPerCitizen: cap })
    ).toThrow(/positive integer/);
  });
});

describe('an app with no policy behaves as it always did', () => {
  it('reports the convar default as its cap', async () => {
    const reply = await call('mine', { app: 'blabber' });
    expect(reply).toMatchObject({ limit: 3 });
  });

  it('follows the convar when it is raised', async () => {
    (globalThis as any).GetConvar = (name: string, f: string) =>
      name === 'mica_max_accounts_per_app' ? '5' : f;
    dbMock.scalar.mockResolvedValueOnce(3);

    const reply = await call('create', { app: 'blabber', handle: 'alt' });

    expect(reply).toMatchObject({ handle: 'alt' });
    expect((dbMock.insert.mock.calls[0][1] as unknown[]).at(-1)).toBe(5);
  });

  it('is searchable', async () => {
    dbMock.query.mockResolvedValueOnce([{ id: 4, app: 'blabber', handle: 'ada' }]);

    const reply = await call('search', { app: 'blabber', q: 'ad' });

    expect(reply.rows).toHaveLength(1);
    expect(flat(dbMock.query.mock.calls[0][0])).toContain('LIKE ?');
  });

  it('can be followed', async () => {
    dbMock.single
      .mockResolvedValueOnce({ id: 1, citizenid: 'CIT_A', app: 'blabber', handle: 'me' })
      .mockResolvedValueOnce({ id: 2, citizenid: 'CIT_B', handle: 'them' });

    const reply = await call('follow', {
      app: 'blabber',
      follower_account_id: 1,
      followee_account_id: 2
    });

    expect(reply).toBe(true);
    expect(dbMock.insert).toHaveBeenCalledOnce();
  });

  it('counts its follow graph', async () => {
    dbMock.scalar.mockResolvedValueOnce(4).mockResolvedValueOnce(2);

    const reply = await call('follows', { app: 'blabber', account_id: 9 });

    expect(reply).toMatchObject({ followers: 4, following: 2 });
  });

  it('lists its followers', async () => {
    await call('followers', { app: 'blabber', account_id: 9 });
    expect(flat(dbMock.query.mock.calls[0][0])).toContain('FROM `mica_account_follows` f');
  });

  it('stays in the generic get, which only leaves the unlisted app out', async () => {
    dbMock.query.mockResolvedValueOnce([{ id: 4, app: 'blabber', handle: 'ada' }]);

    const reply = await call('get', { app: 'blabber', handle: 'ada', limit: 1 });

    expect(reply.rows).toHaveLength(1);
    const [sql, params] = dbMock.query.mock.calls[0];
    expect(flat(sql)).toContain('`app` = ?');
    expect(flat(sql)).toContain('`handle` = ?');
    expect(params).toEqual(expect.arrayContaining(['blabber', 'ada', UNLISTED]));
  });
});

describe('a policy cap', () => {
  it('reports the policy cap, not the convar', async () => {
    (globalThis as any).GetConvar = (name: string, f: string) =>
      name === 'mica_max_accounts_per_app' ? '5' : f;

    expect(await call('mine', { app: UNLISTED })).toMatchObject({ limit: 1 });
    expect(await call('mine', { app: CAPPED })).toMatchObject({ limit: 2 });
  });

  it('refuses the second account for the same citizen with the existing message', async () => {
    dbMock.scalar.mockResolvedValueOnce(1);

    const reply = await call('create', { app: UNLISTED, handle: 'second' });

    expect(reply.error).toMatch(/already hold 1 accounts here/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('allows the first, and puts the policy cap in the insert’s own predicate', async () => {
    const reply = await call('create', { app: UNLISTED, handle: 'first' });

    expect(reply).toMatchObject({ handle: 'first', app: UNLISTED });
    const [sql, params] = dbMock.insert.mock.calls[0];
    expect(flat(sql)).toContain('WHERE cap.held < ?');
    expect((params as unknown[]).slice(-3)).toEqual(['CIT_A', UNLISTED, 1]);
  });

  it('refuses when a concurrent create took the one slot between count and insert', async () => {
    dbMock.insert.mockResolvedValueOnce(0);

    const reply = await call('create', { app: UNLISTED, handle: 'raced' });

    expect(reply.error).toMatch(/already hold 1 accounts here/);
  });
});

describe('an unlisted app', () => {
  it('answers a search empty without reading anything', async () => {
    dbMock.query.mockResolvedValue([{ id: 4, app: UNLISTED, handle: 'ada' }]);

    const reply = await call('search', { app: UNLISTED, q: 'ad' });

    expect(reply).toEqual({ rows: [], nextCursor: null });
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('refuses a follow before it reads or writes', async () => {
    const reply = await call('follow', {
      app: UNLISTED,
      follower_account_id: 1,
      followee_account_id: 2
    });

    expect(reply.error).toBe('Following is not available here.');
    expect(dbMock.single).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses an unfollow', async () => {
    const reply = await call('unfollow', {
      app: UNLISTED,
      follower_account_id: 1,
      followee_account_id: 2
    });

    expect(reply.error).toBe('Following is not available here.');
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('answers follow stats empty without counting', async () => {
    dbMock.scalar.mockResolvedValue(4);

    const reply = await call('follows', { app: UNLISTED, account_id: 9 });

    expect(reply).toEqual({ followers: 0, following: 0, followedByMe: false, blockedByMe: false });
    expect(dbMock.scalar).not.toHaveBeenCalled();
  });

  it('still answers the block state on the stats, because blocks still work', async () => {
    dbMock.single
      .mockResolvedValueOnce({ id: 1, citizenid: 'CIT_A', app: UNLISTED, handle: 'me' })
      .mockResolvedValueOnce({ id: 33 });

    const reply = await call('follows', { app: UNLISTED, account_id: 9, viewer_account_id: 1 });

    expect(reply).toEqual({ followers: 0, following: 0, followedByMe: false, blockedByMe: true });
    const [sql, params] = dbMock.single.mock.calls[1];
    expect(flat(sql)).toContain('FROM `mica_account_blocks`');
    expect(params).toEqual([1, 9]);
  });

  it.each(['followers', 'following'])('answers %s empty without reading', async (action) => {
    dbMock.query.mockResolvedValue([{ id: 4, cursor_id: 1 }]);

    const reply = await call(action, { app: UNLISTED, account_id: 9 });

    expect(reply).toEqual({ rows: [], nextCursor: null });
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('still blocks', async () => {
    dbMock.single
      .mockResolvedValueOnce({ id: 1, citizenid: 'CIT_A', app: UNLISTED, handle: 'me' })
      .mockResolvedValueOnce({ id: 2 });

    const reply = await call('block', {
      app: UNLISTED,
      blocker_account_id: 1,
      blocked_account_id: 2
    });

    expect(reply).toBe(true);
    expect(flat(dbMock.insert.mock.calls[0][0])).toContain('INSERT INTO `mica_account_blocks`');
  });
});

describe('the generic get leaves unlisted apps out in the statement', () => {
  it('excludes the unlisted app when asked for it by name', async () => {
    await call('get', { app: UNLISTED, limit: 10 });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(flat(sql)).toMatch(/WHERE .*`app` = \? .*`app` NOT IN \(\?\)/);
    expect(params).toEqual([UNLISTED, 'active', UNLISTED, 11]);
  });

  it('excludes it from an unfiltered page too, before LIMIT, so pages are not short', async () => {
    await call('get', { limit: 10, cursor: 50 });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(flat(sql)).toMatch(/`app` NOT IN \(\?\) AND `id` < \? ORDER BY `id` DESC LIMIT \?$/);
    expect(params).toEqual(['active', UNLISTED, 50, 11]);
  });

  it('names only the unlisted app, never a listed one with a policy', async () => {
    await call('get', { app: CAPPED });

    const params = dbMock.query.mock.calls[0][1] as unknown[];
    expect(params.filter((param) => param === CAPPED)).toHaveLength(1);
  });

  it('still withholds citizenid from the projection', async () => {
    await call('get', { app: 'blabber' });

    const sql = String(dbMock.query.mock.calls[0][0]);
    expect(sql.startsWith('SELECT `')).toBe(true);
    expect(sql).not.toContain('citizenid');
  });
});

describe('scrubAccount', () => {
  it('blanks the profile fields under an ownership predicate and keeps the handle', async () => {
    expect(await scrubAccount(12, 'CIT_A')).toBe(true);

    const [sql, params] = dbMock.update.mock.calls[0];
    expect(flat(sql)).toMatch(
      /^UPDATE `mica_accounts` SET `display_name` = \?, `bio` = \?, `avatar` = \? WHERE `id` = \? AND `citizenid` = \?/
    );
    expect(flat(sql)).not.toContain('`handle`');
    expect(flat(sql)).not.toContain('`status` =');
    expect(params).toEqual([null, null, null, 12, 'CIT_A']);
  });

  it('cannot run without a citizen', async () => {
    await expect(scrubAccount(12, '')).rejects.toThrow(/requires a citizenid/);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('is not a net event', () => {
    expect([...handlers.keys()].some((event) => /scrub/i.test(event))).toBe(false);
  });
});

/**
 * An app's block hook (MICA-255): Spark ends the match when one end blocks the other, or an
 * unblock brings the pair back into Matches with the thread intact.
 */
describe('onAccountBlocked', () => {
  const ME = { id: 1, citizenid: 'CIT_A', app: UNLISTED, handle: 'me', status: 'active' };
  const THEM = { id: 2, citizenid: 'CIT_B', app: UNLISTED, handle: 'them', status: 'active' };
  const block = (app = UNLISTED) =>
    call('block', { app, blocker_account_id: 1, blocked_account_id: 2 });

  it('throws on a second handler for the same app', () => {
    expect(() => onAccountBlocked(UNLISTED, async () => {})).toThrow(/already has a block handler/);
  });

  it('runs with both accounts once the block row and the follow cascade are written', async () => {
    dbMock.single.mockResolvedValueOnce(ME).mockResolvedValueOnce(THEM);
    blockHandler.mockImplementationOnce(async () => {
      // Written before the handler was called, never after it.
      expect(dbMock.insert).toHaveBeenCalledOnce();
      expect(dbMock.update).toHaveBeenCalledOnce();
    });

    expect(await block()).toBe(true);

    expect(blockHandler).toHaveBeenCalledOnce();
    expect(blockHandler).toHaveBeenCalledWith(ME, THEM);
    await expect(blockHandler.mock.results[0].value).resolves.toBeUndefined();
  });

  it('runs for a block that already existed, since the block is still in place', async () => {
    dbMock.single.mockResolvedValueOnce(ME).mockResolvedValueOnce(THEM);
    dbMock.insert.mockRejectedValueOnce(
      new Error("Duplicate entry '1-2' for key 'blocker_blocked'")
    );

    expect(await block()).toBe(true);
    expect(blockHandler).toHaveBeenCalledOnce();
  });

  it('does not run when the block write is refused', async () => {
    dbMock.single.mockResolvedValueOnce(ME).mockResolvedValueOnce(THEM);
    dbMock.insert.mockRejectedValueOnce(new Error('Lock wait timeout exceeded'));

    const reply = await block();

    expect(reply).not.toBe(true);
    expect(blockHandler).not.toHaveBeenCalled();
  });

  it('does not run when the target is gone or the blocker is not the caller’s', async () => {
    dbMock.single.mockResolvedValueOnce(ME).mockResolvedValueOnce(null);
    expect((await block()).error).toMatch(/no longer available/);

    dbMock.single.mockResolvedValueOnce(null);
    expect((await block()).error).toMatch(/not yours/);

    expect(blockHandler).not.toHaveBeenCalled();
  });

  it('logs a throwing handler and still reports the block as made', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.single.mockResolvedValueOnce(ME).mockResolvedValueOnce(THEM);
    blockHandler.mockRejectedValueOnce(new Error('spark is down'));

    expect(await block()).toBe(true);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(UNLISTED), expect.any(String));
    logged.mockRestore();
  });

  it('runs only the blocking app’s handler', async () => {
    dbMock.single
      .mockResolvedValueOnce({ ...ME, app: CAPPED })
      .mockResolvedValueOnce({ ...THEM, app: CAPPED });

    expect(await block(CAPPED)).toBe(true);
    expect(blockHandler).not.toHaveBeenCalled();
  });
});
