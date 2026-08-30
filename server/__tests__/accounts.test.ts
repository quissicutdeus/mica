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
const getSourceByCitizenId = vi.hoisted(() => vi.fn(() => null));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.current, source: 5, setMeta: () => {} }),
    getCitizenId: () => bridge.current,
    registerUsableItem: () => {},
    // `null` (offline) rather than a crash: nothing here exercises real delivery, and a push
    // being attempted is what `getSourceByCitizenId` having been called stands in for.
    getSourceByCitizenId
  }
}));

import { accounts, ownedAccount } from '../services/Accounts';
import { registerReactable } from '../lib/reactions';

// Registered by `BlabberDms.ts`'s own `defineService` call in the real app, which this file
// never imports — so the reactions tests below register it directly rather than pulling in an
// unrelated service just to trigger its module-scope side effect.
registerReactable('gphone_blabber_dms', { label: 'Direct message' });

const SRC = 5;

const call = async (action: string, data: unknown, citizenid = 'CIT_A') => {
  const handler = handlers.get(`gphone:server:accounts:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);

  bridge.current = citizenid;
  (globalThis as any).source = SRC;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls[0]?.[3];
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(7);
  dbMock.update.mockResolvedValue(true);
  dbMock.single.mockResolvedValue(null);
  dbMock.scalar.mockResolvedValue(0);
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
});

/**
 * Social identities, shared across social apps.
 *
 * The two things worth pinning: a public read must never carry `citizenid`, because with
 * several accounts per player it correlates two deliberately-separate identities back to one
 * person; and nothing may act as an account it does not own, because the `account_id` on a
 * post is a client-chosen value and §2.9 says a payload is not proof of intent.
 */

describe('the declaration', () => {
  it('keeps citizenid out of a public read', () => {
    expect(accounts.resolved.publicColumns).not.toContain('citizenid');
    expect(accounts.resolved.publicColumns).toContain('handle');
  });

  it('makes app and handle unwritable through the generic path', () => {
    // Renaming a handle would silently break every mention of it, and moving an account to
    // another app would let a player squat a namespace they never claimed in.
    expect(accounts.resolved.clientWritable).not.toContain('handle');
    expect(accounts.resolved.clientWritable).not.toContain('app');
    // The presentation fields stay editable, which is what makes the generic update useful.
    expect(accounts.resolved.clientWritable).toEqual(
      expect.arrayContaining(['display_name', 'avatar', 'bio'])
    );
  });

  it('makes handles unique per app rather than globally', () => {
    // `@ada` on Blabber and `@ada` on Instagram are different identities, and may well be
    // different people.
    const unique = accounts.resolved.indexes.find((i) => i.name === 'app_handle');
    expect(unique).toMatchObject({ columns: ['app', 'handle'], unique: true });
  });

  it('declares paging, which a public read cannot go without', () => {
    expect(accounts.resolved.paging).not.toBeNull();
  });

  it('keeps app and handle filterable despite being unwritable', () => {
    // MICA-137. The two flags answer different questions and were derived from one
    // predicate: `clientWritable: false` above silently took `clientFilterable: true` with
    // it. An identity column that is searchable and immutable is the normal case, not a
    // contradiction.
    expect(accounts.resolved.clientFilterable).toEqual(['app', 'handle']);
  });
});

/**
 * The public `get`, which is how a profile is opened.
 *
 * `Profile.svelte` calls `getAccounts({ app, handle, limit: 1 })` and takes the first row. That
 * only identifies an account if both predicates survive `sanitizeFilter` — and for the life of
 * MICA-137 neither did, so the query degraded to "the newest active account in any app" and
 * every profile showed one arbitrary stranger. Asserted against the SQL rather than the reply,
 * because the reply looked entirely plausible while being about somebody else.
 */
describe('looking an account up by handle', () => {
  it('narrows the public read by both app and handle', async () => {
    dbMock.query.mockResolvedValueOnce([{ id: 4, app: 'blabber', handle: 'ada' }]);

    await call('get', { app: 'blabber', handle: 'ada', limit: 1 }, 'CIT_B');

    const sql = String(dbMock.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    const params = dbMock.query.mock.calls[0][1] as unknown[];
    expect(sql).toContain('`app` = ?');
    expect(sql).toContain('`handle` = ?');
    expect(params).toEqual(expect.arrayContaining(['blabber', 'ada']));
  });

  it('still refuses to narrow a public read by owner', async () => {
    // Unchanged by the decoupling, and worth pinning at this level anyway. `citizenid` is
    // withheld from `publicColumns` so a stranger cannot trace a row to its player, and a
    // filter would answer the same question from the row count instead — but what refuses it
    // is `IMPLICIT_COLUMNS`, which never let the column be declared, not the write coupling
    // MICA-137 removed. This asserts the behaviour the player sees, wherever it comes from.
    dbMock.query.mockResolvedValueOnce([]);

    await call('get', { app: 'blabber', citizenid: 'CIT_A' }, 'CIT_B');

    const sql = String(dbMock.query.mock.calls[0][0]);
    const params = dbMock.query.mock.calls[0][1] as unknown[];
    expect(sql).not.toContain('citizenid');
    expect(params).not.toContain('CIT_A');
  });
});

describe('claiming a handle', () => {
  it('creates an account for the caller', async () => {
    const reply = await call('create', { app: 'blabber', handle: 'ada', display_name: 'Ada' });

    expect(reply).toMatchObject({ id: 7, app: 'blabber', handle: 'ada', citizenid: 'CIT_A' });
  });

  it('lowercases the handle so @Ada and @ada cannot both exist', async () => {
    await call('create', { app: 'blabber', handle: 'AdA' });

    const inserted = dbMock.insert.mock.calls[0][1] as unknown[];
    expect(inserted).toContain('ada');
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(33)],
    ['spaces', 'ada lovelace'],
    ['punctuation', 'ada!'],
    ['a leading at-sign', '@ada']
  ])('refuses a handle with %s', async (_label, handle) => {
    const reply = await call('create', { app: 'blabber', handle });

    expect(reply.error).toMatch(/3–32 characters/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a handle already claimed in that app', async () => {
    dbMock.single.mockResolvedValueOnce({ id: 1 });

    const reply = await call('create', { app: 'blabber', handle: 'ada' });

    expect(reply.error).toBe('@ada is taken.');
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('translates a lost race at the unique index into something readable', async () => {
    // Two players claiming in the same instant both pass the pre-check and one loses at the
    // index. That is the correct outcome; the raw driver error is not what a player should read.
    dbMock.insert.mockRejectedValueOnce(new Error("Duplicate entry 'blabber-ada' for key ..."));

    const reply = await call('create', { app: 'blabber', handle: 'ada' });

    expect(reply.error).toBe('@ada is taken.');
  });

  it('caps how many accounts a player may hold in one app', async () => {
    // The handle namespace is public and finite: uncapped, one player claims every good name.
    dbMock.scalar.mockResolvedValueOnce(3);

    const reply = await call('create', { app: 'blabber', handle: 'alt' });

    expect(reply.error).toMatch(/already hold 3 accounts/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  /**
   * MICA-132. `UNIQUE KEY app_handle` says which handle is taken; nothing says how many
   * one citizenid holds, and the count above is a read with a yield between it and the
   * insert. `rateLimit` bounds arrival rather than concurrency, so N creates with N distinct
   * handles all counted `limit - 1` and all inserted — the cap is the only thing rationing a
   * shared, public handle namespace, which makes this squatting at scale.
   *
   * A stub cannot enforce a predicate, so what is asserted is that the statement carries
   * one, and that a refusal by the database is reported as a refusal.
   */
  it('puts the cap in the statement that inserts, not in a query before it', async () => {
    await call('create', { app: 'blabber', handle: 'alt' });

    const [sql, params] = dbMock.insert.mock.calls[0];
    const flat = String(sql).replace(/\s+/g, ' ');
    expect(flat).toContain('INSERT INTO `gphone_accounts`');
    expect(flat).toContain('COUNT(*) AS held');
    expect(flat).toContain('WHERE cap.held < ?');
    // Owner, app and ceiling, bound after the inserted values.
    expect((params as unknown[]).slice(-3)).toEqual(['CIT_A', 'blabber', 3]);
  });

  it('refuses when the last slot went to a concurrent create between count and insert', async () => {
    // The count still says there is room — this is the interleaving where another create
    // took the final slot after that read. Zero rows inserted is how the predicate says no.
    dbMock.scalar.mockResolvedValueOnce(2);
    dbMock.insert.mockResolvedValueOnce(0);

    const reply = await call('create', { app: 'blabber', handle: 'alt' });

    expect(reply.error).toMatch(/already hold 3 accounts/);
  });

  it('lets only one of two overlapping creates take the last slot', async () => {
    // Both handlers count `limit - 1` before either inserts, and both use a distinct handle,
    // so the unique index cannot decide it either. Driven against one stub, released out of
    // order: the second insert finds the cap full because the first committed.
    dbMock.scalar.mockResolvedValue(2);

    let held = 2;
    const gate: (() => void)[] = [];
    dbMock.insert.mockImplementation(async (_sql: string, params: unknown[]) => {
      await new Promise<void>((resolve) => gate.push(resolve));
      const limit = params[params.length - 1] as number;
      if (held >= limit) return 0;
      held += 1;
      return 7;
    });

    const replies = new Map<string, any>();
    bridge.current = 'CIT_A';
    (globalThis as any).source = SRC;
    (globalThis as any).emitNet = vi.fn((...args: any[]) => replies.set(String(args[2]), args[3]));
    const handler = handlers.get('gphone:server:accounts:create')!;
    const running = Promise.all([
      handler('cb-alpha', { app: 'blabber', handle: 'alpha' }),
      handler('cb-beta', { app: 'blabber', handle: 'beta' })
    ]);

    await vi.waitFor(() => expect(gate).toHaveLength(2));
    gate.pop()!();
    gate.pop()!();
    await running;

    const outcomes = [replies.get('cb-alpha'), replies.get('cb-beta')];
    expect(outcomes.filter((reply) => reply?.error === undefined)).toHaveLength(1);
    expect(outcomes.filter((reply) => /already hold/.test(reply?.error ?? ''))).toHaveLength(1);
  });

  it('honors a convar raising the cap', async () => {
    (globalThis as any).GetConvar = (name: string, f: string) =>
      name === 'gphone_max_accounts_per_app' ? '5' : f;
    dbMock.scalar.mockResolvedValueOnce(3);

    const reply = await call('create', { app: 'blabber', handle: 'alt' });

    expect(reply).toMatchObject({ handle: 'alt' });
  });

  it('requires an app id', async () => {
    const reply = await call('create', { handle: 'ada' });

    expect(reply.error).toMatch(/app id is required/);
  });
});

describe('listing my own accounts', () => {
  it('scopes to the caller server-side rather than trusting a filter', async () => {
    // Deliberately not a filter on the public `get`: making citizenid client-filterable would
    // let anyone list anyone's accounts, which is exactly the correlation this table avoids.
    await call('mine', { app: 'blabber' }, 'CIT_B');

    const params = dbMock.query.mock.calls[0][1] as unknown[];
    expect(params).toEqual(['CIT_B', 'blabber']);
  });

  it('requires an app id', async () => {
    const reply = await call('mine', {});

    expect(reply.error).toMatch(/app id is required/);
  });

  it('reports the per-app cap, so the UI does not have to guess a convar', async () => {
    dbMock.query.mockResolvedValueOnce([{ id: 1, handle: 'ada' }]);

    const reply = await call('mine', { app: 'blabber' });

    expect(reply).toMatchObject({ rows: [{ handle: 'ada' }], limit: 3 });
  });

  it('reports a raised cap from the convar', async () => {
    (globalThis as any).GetConvar = (name: string, f: string) =>
      name === 'gphone_max_accounts_per_app' ? '5' : f;
    dbMock.query.mockResolvedValueOnce([]);

    const reply = await call('mine', { app: 'blabber' });

    expect(reply).toMatchObject({ rows: [], limit: 5 });
  });
});

describe('ownedAccount', () => {
  it('returns the account when it belongs to the caller in that app', async () => {
    dbMock.single.mockResolvedValueOnce({ id: 3, handle: 'ada', app: 'blabber' });

    await expect(ownedAccount(3, 'CIT_A', 'blabber')).resolves.toMatchObject({ handle: 'ada' });

    const params = dbMock.single.mock.calls[0][1] as unknown[];
    expect(params).toEqual([3, 'CIT_A', 'blabber']);
  });

  it('returns null for an account belonging to somebody else', async () => {
    // The whole point: `account_id` on a post is chosen by the client, and nothing about the
    // payload proves the account is theirs.
    dbMock.single.mockResolvedValueOnce(null);

    await expect(ownedAccount(3, 'CIT_OTHER', 'blabber')).resolves.toBeNull();
  });

  it.each([
    ['a non-numeric id', 'not-a-number'],
    ['zero', 0],
    ['a negative id', -1],
    ['undefined', undefined]
  ])('returns null for %s without querying', async (_label, id) => {
    await expect(ownedAccount(id, 'CIT_A', 'blabber')).resolves.toBeNull();
    expect(dbMock.single).not.toHaveBeenCalled();
  });
});

/**
 * The follow graph.
 *
 * Shared rather than Blabber's, so it lives here. Every action verifies the *acting* account
 * first: `follower_account_id` arrives in a payload and nothing about a payload proves it belongs
 * to the session that sent it (§2.9). Without that check a player follows and unfollows on anyone
 * else's behalf by guessing an id.
 */
describe('following', () => {
  const MINE = { id: 3, citizenid: 'CIT_A', app: 'blabber', handle: 'ada', status: 'active' };

  it('refuses to follow as an account the caller does not own', async () => {
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('follow', {
      app: 'blabber',
      follower_account_id: 9,
      followee_account_id: 4
    });

    expect(reply.error).toMatch(/not yours/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses to follow yourself', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);

    const reply = await call('follow', {
      app: 'blabber',
      follower_account_id: 3,
      followee_account_id: 3
    });

    // It would put your own posts in your Following feed and inflate both counts for everybody.
    expect(reply.error).toMatch(/cannot follow yourself/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a followee that is gone or in another app', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);
    // The followee lookup, scoped by app — a row linking two apps' accounts is a relation
    // neither app's feed could explain.
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('follow', {
      app: 'blabber',
      follower_account_id: 3,
      followee_account_id: 4
    });

    expect(reply.error).toMatch(/no longer available/);
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(dbMock.single.mock.calls[1][1]).toEqual([4, 'blabber']);
  });

  it('inserts the verified account id, never the payload’s', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);
    dbMock.single.mockResolvedValueOnce({ id: 4 });

    await call('follow', {
      app: 'blabber',
      follower_account_id: 3,
      followee_account_id: 4
    });

    expect(dbMock.insert.mock.calls[0][1]).toEqual([MINE.id, 4]);
  });

  it('treats a duplicate as success, because the unique index is what makes it idempotent', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);
    dbMock.single.mockResolvedValueOnce({ id: 4 });
    dbMock.insert.mockRejectedValueOnce(new Error('ER_DUP_ENTRY: Duplicate entry'));

    const reply = await call('follow', {
      app: 'blabber',
      follower_account_id: 3,
      followee_account_id: 4
    });

    // From the player's point of view the follow is exactly as applied as they wanted.
    expect(reply).toBe(true);
  });

  it('does not swallow a real insert failure', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);
    dbMock.single.mockResolvedValueOnce({ id: 4 });
    dbMock.insert.mockRejectedValueOnce(new Error('ER_NO_SUCH_TABLE'));

    const reply = await call('follow', {
      app: 'blabber',
      follower_account_id: 3,
      followee_account_id: 4
    });

    expect(reply.error).toBeTruthy();
  });

  it('scopes an unfollow to the caller’s own account', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);

    await call('unfollow', {
      app: 'blabber',
      follower_account_id: 3,
      followee_account_id: 4
    });

    // A row id alone is never authorization to remove somebody else's follow.
    expect(dbMock.update.mock.calls[0][1]).toEqual([MINE.id, 4]);
  });

  it('refuses an unfollow as an account the caller does not own', async () => {
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('unfollow', {
      app: 'blabber',
      follower_account_id: 9,
      followee_account_id: 4
    });

    expect(reply.error).toMatch(/not yours/);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('counts both directions and answers whether the viewer follows', async () => {
    dbMock.single.mockResolvedValueOnce(MINE); // the viewer, owned
    dbMock.scalar.mockResolvedValueOnce(12); // followers of the profile
    dbMock.scalar.mockResolvedValueOnce(4); // accounts the profile follows
    dbMock.single.mockResolvedValueOnce({ id: 77 }); // the viewer's own follow row

    const reply = await call('follows', {
      app: 'blabber',
      account_id: 4,
      viewer_account_id: 3
    });

    expect(reply).toEqual({ followers: 12, following: 4, followedByMe: true, blockedByMe: false });
  });

  it('answers followedByMe false for a viewer the caller does not own', async () => {
    // Reading a profile is not a privileged act, so this is `false` rather than an error — only
    // the Follow *button* needs an identity.
    dbMock.single.mockResolvedValueOnce(null);
    dbMock.scalar.mockResolvedValueOnce(1);
    dbMock.scalar.mockResolvedValueOnce(2);

    const reply = await call('follows', {
      app: 'blabber',
      account_id: 4,
      viewer_account_id: 999
    });

    expect(reply).toMatchObject({ followers: 1, following: 2, followedByMe: false });
  });

  it('answers counts with no viewer at all', async () => {
    dbMock.scalar.mockResolvedValueOnce(0);
    dbMock.scalar.mockResolvedValueOnce(0);

    const reply = await call('follows', { app: 'blabber', account_id: 4 });

    expect(reply).toEqual({ followers: 0, following: 0, followedByMe: false, blockedByMe: false });
  });

  it('requires an app id, since the graph is per app', async () => {
    const reply = await call('follow', { follower_account_id: 3, followee_account_id: 4 });

    expect(reply.error).toMatch(/app id is required/);
  });
});

describe('blocking', () => {
  const MINE = { id: 3, citizenid: 'CIT_A', app: 'blabber', handle: 'ada', status: 'active' };

  it('refuses to block as an account the caller does not own', async () => {
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('block', {
      app: 'blabber',
      blocker_account_id: 9,
      blocked_account_id: 4
    });

    expect(reply.error).toMatch(/not yours/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses to block yourself', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);

    const reply = await call('block', {
      app: 'blabber',
      blocker_account_id: 3,
      blocked_account_id: 3
    });

    expect(reply.error).toMatch(/cannot block yourself/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a target that is gone or in another app', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('block', {
      app: 'blabber',
      blocker_account_id: 3,
      blocked_account_id: 4
    });

    expect(reply.error).toMatch(/no longer available/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('inserts the verified account id and cascades the follow graph both directions', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);
    dbMock.single.mockResolvedValueOnce({ id: 4 });

    await call('block', {
      app: 'blabber',
      blocker_account_id: 3,
      blocked_account_id: 4
    });

    expect(dbMock.insert.mock.calls[0][1]).toEqual([MINE.id, 4]);
    // Both directions in one statement, so a stale "blocked but still following" row cannot
    // survive either way.
    const [sql, params] = dbMock.update.mock.calls[0];
    expect(String(sql)).toContain('gphone_account_follows');
    expect(params).toEqual([3, 4, 4, 3]);
  });

  it('treats a duplicate block as success, same as follow', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);
    dbMock.single.mockResolvedValueOnce({ id: 4 });
    dbMock.insert.mockRejectedValueOnce(new Error('ER_DUP_ENTRY: Duplicate entry'));

    const reply = await call('block', {
      app: 'blabber',
      blocker_account_id: 3,
      blocked_account_id: 4
    });

    expect(reply).toBe(true);
  });

  it('scopes an unblock to the caller’s own account', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);

    await call('unblock', {
      app: 'blabber',
      blocker_account_id: 3,
      blocked_account_id: 4
    });

    expect(dbMock.update.mock.calls[0][1]).toEqual([MINE.id, 4]);
  });

  it('refuses an unblock as an account the caller does not own', async () => {
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('unblock', {
      app: 'blabber',
      blocker_account_id: 9,
      blocked_account_id: 4
    });

    expect(reply.error).toMatch(/not yours/);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('suppresses the follow notification when the followee has blocked the follower', async () => {
    dbMock.single.mockResolvedValueOnce(MINE); // ownedAccount(follower)
    dbMock.single.mockResolvedValueOnce({ id: 4, citizenid: 'CIT_B', handle: 'bob' }); // followee
    dbMock.single.mockResolvedValueOnce({ id: 1 }); // isBlocked(followee, follower) -> blocked

    await call('follow', {
      app: 'blabber',
      follower_account_id: 3,
      followee_account_id: 4
    });

    // `getSourceByCitizenId` is the first thing an attempted push does — never reached when
    // the followee has blocked the follower.
    expect(getSourceByCitizenId).not.toHaveBeenCalled();
  });

  it('still notifies a follow when there is no block', async () => {
    dbMock.single.mockResolvedValueOnce(MINE); // ownedAccount(follower)
    dbMock.single.mockResolvedValueOnce({ id: 4, citizenid: 'CIT_B', handle: 'bob' }); // followee
    dbMock.single.mockResolvedValueOnce(null); // isBlocked(followee, follower) -> not blocked

    await call('follow', {
      app: 'blabber',
      follower_account_id: 3,
      followee_account_id: 4
    });

    expect(getSourceByCitizenId).toHaveBeenCalledWith('CIT_B');
  });
});

describe('reactions', () => {
  const MINE = { id: 3, citizenid: 'CIT_A', app: 'blabber', handle: 'ada', status: 'active' };

  it('refuses a reaction as an account the caller does not own', async () => {
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('react', {
      app: 'blabber',
      account_id: 9,
      target_table: 'gphone_blabber_dms',
      target_id: 4,
      emoji: '👍'
    });

    expect(reply.error).toMatch(/not yours/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a table that never opted in', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);

    const reply = await call('react', {
      app: 'blabber',
      account_id: 3,
      target_table: 'gphone_players',
      target_id: 4,
      emoji: '👍'
    });

    expect(reply.error).toMatch(/cannot be reacted to/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a value that is not a plausible single emoji', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);

    const reply = await call('react', {
      app: 'blabber',
      account_id: 3,
      target_table: 'gphone_blabber_dms',
      target_id: 4,
      emoji: 'not an emoji at all, this is far too long'
    });

    expect(reply.error).toMatch(/not a single emoji/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('inserts a reaction on a reactable table', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);

    await call('react', {
      app: 'blabber',
      account_id: 3,
      target_table: 'gphone_blabber_dms',
      target_id: 4,
      emoji: '👍'
    });

    expect(dbMock.insert.mock.calls[0][1]).toEqual([3, 'gphone_blabber_dms', 4, '👍']);
  });

  it('treats a duplicate reaction as success', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);
    dbMock.insert.mockRejectedValueOnce(new Error('ER_DUP_ENTRY: Duplicate entry'));

    const reply = await call('react', {
      app: 'blabber',
      account_id: 3,
      target_table: 'gphone_blabber_dms',
      target_id: 4,
      emoji: '👍'
    });

    expect(reply).toBe(true);
  });

  it('scopes an unreact to the caller’s own account', async () => {
    dbMock.single.mockResolvedValueOnce(MINE);

    await call('unreact', {
      app: 'blabber',
      account_id: 3,
      target_table: 'gphone_blabber_dms',
      target_id: 4,
      emoji: '👍'
    });

    expect(dbMock.update.mock.calls[0][1]).toEqual([3, 'gphone_blabber_dms', 4, '👍']);
  });

  it('refuses reactionsFor on a table that never opted in', async () => {
    const reply = await call('reactionsFor', {
      app: 'blabber',
      target_table: 'gphone_players',
      target_ids: [1, 2]
    });

    expect(reply.error).toMatch(/cannot be reacted to/);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('answers empty for no target ids, without querying', async () => {
    const reply = await call('reactionsFor', {
      app: 'blabber',
      target_table: 'gphone_blabber_dms',
      target_ids: []
    });

    expect(reply).toEqual({});
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('groups counts per target and emoji, and reports which are the caller’s own', async () => {
    dbMock.query
      .mockResolvedValueOnce([
        { target_id: 4, emoji: '👍', total: 2 },
        { target_id: 4, emoji: '❤️', total: 1 },
        { target_id: 5, emoji: '👍', total: 1 }
      ])
      .mockResolvedValueOnce([{ id: 3 }]) // the caller's own accounts in this app
      .mockResolvedValueOnce([{ target_id: 4, emoji: '👍' }]);

    const reply = await call('reactionsFor', {
      app: 'blabber',
      target_table: 'gphone_blabber_dms',
      target_ids: [4, 5]
    });

    expect(reply).toEqual({
      4: { counts: { '👍': 2, '❤️': 1 }, mine: ['👍'] },
      5: { counts: { '👍': 1 }, mine: [] }
    });
  });
});

/**
 * The two lists behind the counts.
 *
 * Public, like the counts they hang off: requiring ownership would mean you could only see your own
 * followers, which is not what the number on a stranger's profile is counting. So what has to hold
 * is that the projection still withholds `citizenid` — a follower list is the one screen that would
 * otherwise correlate every alt in the graph back to its owner — and that the paging is the keyset
 * shape every other paged read uses.
 */
const rowsFrom = (ids: number[]) =>
  ids.map((id) => ({
    id,
    handle: `h${id}`,
    app: 'blabber',
    status: 'active',
    cursor_id: id * 10
  }));

describe('follower and following lists', () => {
  it('lists who follows an account, newest relation first', async () => {
    dbMock.query.mockResolvedValueOnce(rowsFrom([7, 8]));

    const reply = await call('followers', { app: 'blabber', account_id: 4 });

    const [sql, params] = dbMock.query.mock.calls[0];
    // The subject is the followee, and the row listed is the follower.
    expect(sql).toMatch(/WHERE f\.`followee_account_id` = \?/);
    expect(sql).toMatch(/JOIN `gphone_accounts` a ON a\.`id` = f\.`follower_account_id`/);
    // On the follow row's own id, not the account's: account order is "whoever signed up first",
    // which is not a thing a reader can make sense of in a follower list.
    expect(sql).toMatch(/ORDER BY f\.`id` DESC/);
    expect(params.slice(0, 2)).toEqual([4, 'blabber']);
    expect(reply.rows).toHaveLength(2);
  });

  it('lists who an account follows, off the other end of the same table', async () => {
    dbMock.query.mockResolvedValueOnce(rowsFrom([1]));

    await call('following', { app: 'blabber', account_id: 4 });

    const [sql] = dbMock.query.mock.calls[0];
    expect(sql).toMatch(/WHERE f\.`follower_account_id` = \?/);
    expect(sql).toMatch(/JOIN `gphone_accounts` a ON a\.`id` = f\.`followee_account_id`/);
  });

  it('never projects citizenid, on either direction', async () => {
    dbMock.query.mockResolvedValueOnce([]);
    await call('followers', { app: 'blabber', account_id: 4 });
    dbMock.query.mockResolvedValueOnce([]);
    await call('following', { app: 'blabber', account_id: 4 });

    for (const [sql] of dbMock.query.mock.calls) {
      // Enforced in the SELECT rather than by dropping a key afterwards, so no override can
      // re-add a column the query never named.
      expect(sql).not.toMatch(/citizenid/);
      expect(sql).toMatch(/a\.`handle`/);
    }
  });

  it('is public — no ownership check, because the count on a stranger’s profile is not yours', async () => {
    dbMock.query.mockResolvedValueOnce(rowsFrom([7]));

    const reply = await call('followers', { app: 'blabber', account_id: 4 }, 'SOMEONE_ELSE');

    expect(reply.rows).toHaveLength(1);
    // `ownedAccount` would have gone through `single`. Nothing here needs an identity.
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('returns the cursor on the envelope and not on the rows', async () => {
    // The probe row is what says there is more; it is never returned.
    dbMock.query.mockResolvedValueOnce(rowsFrom([7, 8, 9]));

    const reply = await call('followers', { app: 'blabber', account_id: 4, limit: 2 });

    expect(reply.rows).toHaveLength(2);
    expect(reply.nextCursor).toBe(80);
    // A position in this result set, not a fact about the account — a client handed both would
    // have two plausible things to page from.
    for (const row of reply.rows) expect(row).not.toHaveProperty('cursor_id');
  });

  it('says the end is the end', async () => {
    dbMock.query.mockResolvedValueOnce(rowsFrom([7]));

    const reply = await call('followers', { app: 'blabber', account_id: 4, limit: 30 });

    // A client that cannot tell "no more" from "ask again" scrolls forever.
    expect(reply.nextCursor).toBeNull();
  });

  it('clamps an over-large limit rather than refusing it', async () => {
    dbMock.query.mockResolvedValueOnce([]);

    await call('followers', { app: 'blabber', account_id: 4, limit: 5000 });

    // The request is legitimate; only the number is not. `maxPageSize` is 60, plus the probe row.
    const params = dbMock.query.mock.calls[0][1];
    expect(params[params.length - 1]).toBe(61);
  });

  it('binds a cursor and rejects one that is not a row id', async () => {
    dbMock.query.mockResolvedValueOnce([]);
    await call('followers', { app: 'blabber', account_id: 4, cursor: 42 });
    expect(dbMock.query.mock.calls[0][0]).toMatch(/AND f\.`id` < \?/);
    expect(dbMock.query.mock.calls[0][1]).toEqual([4, 'blabber', 42, 31]);

    const reply = await call('followers', { app: 'blabber', account_id: 4, cursor: 'DROP TABLE' });
    // A cursor names a position, never a column, which is why it is an integer and not an
    // opaque string.
    expect(reply.error).toBeTruthy();
  });

  it('requires an app id and an account id', async () => {
    expect((await call('followers', { account_id: 4 })).error).toMatch(/app id is required/);
    expect((await call('following', { app: 'blabber' })).error).toMatch(/account id/);
  });
});

describe('the follow graph declaration', () => {
  it('is a child table with no citizenid', () => {
    const follows = accounts.resolved.childTables?.find(
      (table) => table.name === 'gphone_account_follows'
    );

    expect(follows).toBeDefined();
    // None is needed: every account row carries an `app`, so a row can only link two accounts in
    // the same app. Ownership stays behind each account and invisible to readers.
    expect(Object.keys(follows!.columns)).toEqual([
      'follower_account_id',
      'followee_account_id',
      'created_at'
    ]);
  });

  it('indexes the following list so its paging is a range scan', () => {
    const follows = accounts.resolved.childTables?.find(
      (table) => table.name === 'gphone_account_follows'
    );

    /**
     * The unique index starts with `follower_account_id` and InnoDB appends the primary key, so
     * for one follower it is physically `(follower_account_id, followee_account_id, id)` — rows in
     * followee order, not id order, which is a filesort for a list paged on `id DESC`. The other
     * direction needs no such key: `followee_account_id` is non-unique, so its appended primary
     * key already makes it `(followee_account_id, id)`.
     */
    expect(follows!.indexes).toEqual(
      expect.arrayContaining([{ name: 'follower_recent', columns: ['follower_account_id', 'id'] }])
    );
  });

  it('constrains one row per relation in the database', () => {
    const follows = accounts.resolved.childTables?.find(
      (table) => table.name === 'gphone_account_follows'
    );
    const unique = follows!.indexes?.find((index: any) => index.unique);

    // A constraint rather than find-then-insert, which has a race two rapid taps would find.
    expect(unique).toMatchObject({
      columns: ['follower_account_id', 'followee_account_id'],
      unique: true
    });
  });
});
