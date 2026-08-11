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
    getSourceByCitizenId: () => 6,
    getSourcesByCitizenId: () => new Map([['CIT_B', 6]]),
    registerUsableItem: () => {}
  }
}));

import { blabberDms } from '../services/BlabberDms';

const MY_ACCOUNT = { id: 1, citizenid: 'CIT_A', app: 'blabber', handle: 'ada', status: 'active' };
const PEER = { id: 2, citizenid: 'CIT_B', handle: 'nightowl' };

const call = async (action: string, data: unknown, citizenid = 'CIT_A') => {
  const handler = handlers.get(`gphone:server:blabber_dms:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);
  bridge.current = citizenid;
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.single.mockReset();
  dbMock.insert.mockReset();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(70);
  dbMock.update.mockResolvedValue(true);
  dbMock.single.mockResolvedValue(null);
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
});

/**
 * Blabber DMs. Strictly 1:1.
 *
 * The shape is the constraint: two account columns and no participants table, so there is nothing
 * a third person could be added to. Contrast Conversations, which needs a join table precisely
 * because its threads can grow.
 */

describe('the declaration', () => {
  it('is 1:1 by construction, with no membership table', () => {
    expect(blabberDms.resolved.membership).toBeNull();
    expect(blabberDms.resolved.columns).toEqual(
      expect.arrayContaining(['from_account', 'to_account'])
    );
    expect(blabberDms.resolved.childTables).toHaveLength(0);
  });

  it('lets a client write nothing through the generic path', () => {
    // Both accounts and read_at are server-set; the body only ever arrives through `send`,
    // which verifies the sending account first.
    expect(blabberDms.resolved.clientWritable).toEqual(['body']);
  });

  it('indexes both directions, because a thread is their union', () => {
    const names = blabberDms.resolved.indexes.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(['from_to', 'to_from', 'to_unread']));
  });
});

describe('sending', () => {
  it('sends from an account the caller owns to one that exists', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce(PEER);

    const reply = await call('send', { account_id: 1, peer_account_id: 2, body: 'hello' });

    expect(reply).toMatchObject({ id: 70, from_account: 1, to_account: 2, body: 'hello' });
  });

  it('notifies the recipient', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce(PEER);

    await call('send', { account_id: 1, peer_account_id: 2, body: 'hello' });

    // The push goes out on the shared app-event channel, addressed to the peer's owner.
    const pushes = (globalThis.emitNet as any).mock.calls.filter(
      (args: unknown[]) => args[0] === 'gphone:client:shell:appEvent'
    );
    expect(pushes).toHaveLength(1);
    expect(pushes[0][2]).toMatchObject({ app: 'blabber', event: 'dm' });
  });

  it('refuses to send from an account the caller does not own', async () => {
    // `account_id` is client-chosen and proves nothing (§2.9) — without this a player sends as
    // anyone's handle.
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('send', { account_id: 999, peer_account_id: 2, body: 'x' });

    expect(reply.error).toMatch(/not yours to send from/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a recipient that does not exist', async () => {
    // An unchecked peer id writes a row pointing at nothing, or at another app's namespace.
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('send', { account_id: 1, peer_account_id: 404, body: 'x' });

    expect(reply.error).toMatch(/No such account/);
  });

  it('refuses messaging yourself', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    const reply = await call('send', { account_id: 1, peer_account_id: 1, body: 'x' });

    expect(reply.error).toMatch(/cannot message yourself/);
  });

  it('refuses an empty body', async () => {
    const reply = await call('send', { account_id: 1, peer_account_id: 2, body: '   ' });

    expect(reply.error).toMatch(/needs something in it/);
  });

  it('refuses a send when the sender has blocked the recipient', async () => {
    dbMock.single
      .mockResolvedValueOnce(MY_ACCOUNT) // ownedAccount
      .mockResolvedValueOnce(PEER) // recipient lookup
      .mockResolvedValueOnce({ id: 5 }); // isBlocked(mine, peer) -> blocked

    const reply = await call('send', { account_id: 1, peer_account_id: 2, body: 'hi' });

    expect(reply.error).toMatch(/can't message this account/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a send when the recipient has blocked the sender', async () => {
    dbMock.single
      .mockResolvedValueOnce(MY_ACCOUNT) // ownedAccount
      .mockResolvedValueOnce(PEER) // recipient lookup
      .mockResolvedValueOnce(null) // isBlocked(mine, peer) -> not blocked
      .mockResolvedValueOnce({ id: 5 }); // isBlocked(peer, mine) -> blocked

    const reply = await call('send', { account_id: 1, peer_account_id: 2, body: 'hi' });

    expect(reply.error).toMatch(/can't message this account/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

describe('reading a thread', () => {
  it('reads both directions between the two accounts', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    await call('get', { account_id: 1, peer_account_id: 2 });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('`from_account` = ? AND `to_account` = ?');
    expect(String(sql)).toContain('OR (`from_account` = ? AND `to_account` = ?)');
    // Both orderings bound, then the page size.
    expect(params).toEqual([1, 2, 2, 1, 41]);
  });

  it('refuses to read a thread the caller owns no side of', async () => {
    // Owning one side is the 1:1 equivalent of a membership check. Without it a client walks
    // account ids and reads anyone's messages.
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('get', { account_id: 999, peer_account_id: 2 });

    expect(reply.error).toMatch(/not yours/);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('clamps the page size', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    await call('get', { account_id: 1, peer_account_id: 2, limit: 5000 });

    expect((dbMock.query.mock.calls[0][1] as unknown[]).at(-1)).toBe(81);
  });
});

describe('marking read', () => {
  it('only clears messages addressed to an account the caller owns', async () => {
    // The WHERE clause is the authorization: there is no id that clears somebody else's unread
    // count.
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    await call('read', { account_id: 1, peer_account_id: 2 });

    const [sql, params] = dbMock.update.mock.calls[0];
    expect(String(sql)).toContain('`to_account` = ? AND `from_account` = ?');
    expect(params).toEqual([1, 2]);
  });
});

describe('the inbox', () => {
  it('answers nothing for a player with no accounts, without querying messages', async () => {
    dbMock.query.mockResolvedValueOnce([]);

    await expect(call('threads', {})).resolves.toEqual([]);
    expect(dbMock.query).toHaveBeenCalledTimes(1);
  });

  it('groups by correspondent rather than pulling every message', async () => {
    // An inbox is small; the history behind it is not. Pulling all of it across NUI to reduce in
    // the client is the shape that stops working quietly at scale.
    dbMock.query.mockResolvedValueOnce([{ id: 1 }]);
    dbMock.query.mockResolvedValueOnce([{ peer: 2, last_id: 9 }]);
    dbMock.query.mockResolvedValueOnce([{ id: 9, from_account: 2, to_account: 1, body: 'hi' }]);
    dbMock.query.mockResolvedValueOnce([{ id: 2, handle: 'nightowl', display_name: 'Night Owl' }]);
    dbMock.query.mockResolvedValueOnce([{ from_account: 2, total: 3 }]);

    const reply = await call('threads', {});

    expect(String(dbMock.query.mock.calls[1][0])).toContain('GROUP BY peer');
    expect(reply).toEqual([
      {
        peer_account_id: 2,
        handle: 'nightowl',
        display_name: 'Night Owl',
        last: { id: 9, from_account: 2, to_account: 1, body: 'hi' },
        unread: 3
      }
    ]);
  });
});
