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
    getSourceByCitizenId: () => 6,
    getSourcesByCitizenId: () => new Map([['CIT_B', 6]]),
    registerUsableItem: () => {}
  }
}));

import {
  deleteThread,
  directMessages,
  registerDmPolicy,
  unregisterDmPolicyForTests
} from '../services/DirectMessages';
// Blabber's policy is registered by its own service file, as in game.
import '../services/Blabber';
import { NOT_HELD_REPLY, refusePhone } from './phoneStub';

const MY_ACCOUNT = { id: 1, citizenid: 'CIT_A', app: 'blabber', handle: 'ada', status: 'active' };
const PEER = { id: 2, citizenid: 'CIT_B', handle: 'nightowl' };

const call = async (action: string, data: unknown, citizenid = 'CIT_A') => {
  const handler = handlers.get(`mica:server:dms:${action}`);
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
  for (const id of ['testapp', 'strictapp', 'readapp']) unregisterDmPolicyForTests(id);
});

/** The pushes the shell received, on the shared app-event net event. */
const pushes = (): any[] =>
  (globalThis.emitNet as any).mock.calls
    .filter((args: unknown[]) => args[0] === 'mica:client:shell:appEvent')
    .map((args: unknown[]) => args[2]);

/**
 * DMs, for any social app (MICA-390). Strictly 1:1.
 *
 * The shape is the constraint: two account columns and no participants table, so there is nothing
 * a third person could be added to. Contrast Conversations, which needs a join table precisely
 * because its threads can grow.
 */

describe('the declaration', () => {
  it('is 1:1 by construction, with no membership table', () => {
    expect(directMessages.resolved.membership).toBeNull();
    expect(directMessages.resolved.columns).toEqual(
      expect.arrayContaining(['from_account', 'to_account'])
    );
    expect(directMessages.resolved.childTables).toHaveLength(0);
  });

  it('lets a client write nothing through the generic path', () => {
    // Both accounts and read_at are server-set; the body only ever arrives through `send`,
    // which verifies the sending account first.
    expect(directMessages.resolved.clientWritable).toEqual(['body']);
  });

  it('indexes both directions, because a thread is their union', () => {
    const names = directMessages.resolved.indexes.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(['from_to', 'to_from', 'to_unread']));
  });
});

describe('sending', () => {
  it('sends from an account the caller owns to one that exists', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce(PEER);

    const reply = await call('send', {
      app: 'blabber',
      account_id: 1,
      peer_account_id: 2,
      body: 'hello'
    });

    expect(reply).toMatchObject({ id: 70, from_account: 1, to_account: 2, body: 'hello' });
  });

  it('notifies the recipient', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce(PEER);

    await call('send', { app: 'blabber', account_id: 1, peer_account_id: 2, body: 'hello' });

    // The push goes out on Blabber's channel, through Blabber's own policy: the sender's handle
    // and the text, opening the thread keyed on that handle.
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0]).toMatchObject({
      app: 'blabber',
      event: 'dm',
      payload: { peer_account_id: 1, handle: 'ada' },
      notify: { title: '@ada', message: 'hello' },
      deepLink: 'blabber?dmHandle=ada'
    });
  });

  it('refuses to send from an account the caller does not own', async () => {
    // `account_id` is client-chosen and proves nothing (§2.9) — without this a player sends as
    // anyone's handle.
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('send', {
      app: 'blabber',
      account_id: 999,
      peer_account_id: 2,
      body: 'x'
    });

    expect(reply.error).toMatch(/not yours to send from/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a recipient that does not exist', async () => {
    // An unchecked peer id writes a row pointing at nothing, or at another app's namespace.
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('send', {
      app: 'blabber',
      account_id: 1,
      peer_account_id: 404,
      body: 'x'
    });

    expect(reply.error).toMatch(/No such account/);
  });

  it('refuses messaging yourself', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    const reply = await call('send', {
      app: 'blabber',
      account_id: 1,
      peer_account_id: 1,
      body: 'x'
    });

    expect(reply.error).toMatch(/cannot message yourself/);
  });

  it('refuses a DM from a player holding no phone, before anything is read or written', async () => {
    // MICA-339: a modified client can emit the send with the phone closed; the server asks.
    refusePhone();

    const reply = await call('send', {
      app: 'blabber',
      account_id: 1,
      peer_account_id: 2,
      body: 'hello'
    });

    expect(reply).toEqual(NOT_HELD_REPLY);
    expect(dbMock.single).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses an empty body', async () => {
    const reply = await call('send', {
      app: 'blabber',
      account_id: 1,
      peer_account_id: 2,
      body: '   '
    });

    expect(reply.error).toMatch(/needs something in it/);
  });

  it('refuses a send when the sender has blocked the recipient', async () => {
    dbMock.single
      .mockResolvedValueOnce(MY_ACCOUNT) // ownedAccount
      .mockResolvedValueOnce(PEER) // recipient lookup
      .mockResolvedValueOnce({ id: 5 }); // isBlocked(mine, peer) -> blocked

    const reply = await call('send', {
      app: 'blabber',
      account_id: 1,
      peer_account_id: 2,
      body: 'hi'
    });

    expect(reply.error).toMatch(/can't message this account/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a send when the recipient has blocked the sender', async () => {
    dbMock.single
      .mockResolvedValueOnce(MY_ACCOUNT) // ownedAccount
      .mockResolvedValueOnce(PEER) // recipient lookup
      .mockResolvedValueOnce(null) // isBlocked(mine, peer) -> not blocked
      .mockResolvedValueOnce({ id: 5 }); // isBlocked(peer, mine) -> blocked

    const reply = await call('send', {
      app: 'blabber',
      account_id: 1,
      peer_account_id: 2,
      body: 'hi'
    });

    expect(reply.error).toMatch(/can't message this account/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

describe('reading a thread', () => {
  it('reads both directions between the two accounts', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    await call('get', { app: 'blabber', account_id: 1, peer_account_id: 2 });

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

    const reply = await call('get', { app: 'blabber', account_id: 999, peer_account_id: 2 });

    expect(reply.error).toMatch(/not yours/);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('clamps the page size', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    await call('get', { app: 'blabber', account_id: 1, peer_account_id: 2, limit: 5000 });

    expect((dbMock.query.mock.calls[0][1] as unknown[]).at(-1)).toBe(81);
  });
});

describe('who is behind an account (MICA-339)', () => {
  /**
   * Identity in a DM is the account. A peer reading their own thread got the replier's
   * `citizenid` on every row, which links one player's alts to each other and to the character.
   * Rows here carry the column, the way a `SELECT *` hands it back, so these fail on a read that
   * only stops asking for it in SQL and passes the row through.
   */
  const PEER_ROW = {
    id: 9,
    citizenid: 'CIT_B',
    from_account: 2,
    to_account: 1,
    body: 'hi',
    read_at: null,
    status: 'active'
  };

  it('never names the column in a thread read', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    await call('get', { app: 'blabber', account_id: 1, peer_account_id: 2 });

    const sql = String(dbMock.query.mock.calls[0][0]);
    expect(sql).not.toContain('*');
    expect(sql).not.toContain('citizenid');
    // The positive twin: the encryption scope a sealed body opens against is still selected.
    expect(sql).toContain('`from_account`, `to_account`, `body`');
  });

  it("hands a thread read back without the sender's citizenid", async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.query.mockResolvedValueOnce([PEER_ROW]);

    const reply = await call('get', { app: 'blabber', account_id: 1, peer_account_id: 2 });

    expect(reply.rows).toHaveLength(1);
    expect(reply.rows[0]).not.toHaveProperty('citizenid');
    expect(reply.rows[0]).toMatchObject({ id: 9, from_account: 2, to_account: 1, body: 'hi' });
  });

  it("hands the inbox's last message back without the sender's citizenid", async () => {
    dbMock.query.mockResolvedValueOnce([{ id: 1 }]);
    dbMock.query.mockResolvedValueOnce([{ peer: 2, last_id: 9 }]);
    dbMock.query.mockResolvedValueOnce([PEER_ROW]);
    dbMock.query.mockResolvedValueOnce([{ id: 2, handle: 'nightowl', display_name: null }]);
    dbMock.query.mockResolvedValueOnce([]);

    const reply = await call('threads', { app: 'blabber' });

    const sql = String(dbMock.query.mock.calls[2][0]);
    expect(sql).not.toContain('*');
    expect(sql).not.toContain('citizenid');
    expect(reply[0].last).not.toHaveProperty('citizenid');
    expect(reply[0].last).toMatchObject({ id: 9, body: 'hi' });
  });
});

describe('marking read', () => {
  it('only clears messages addressed to an account the caller owns', async () => {
    // The WHERE clause is the authorization: there is no id that clears somebody else's unread
    // count.
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    await call('read', { app: 'blabber', account_id: 1, peer_account_id: 2 });

    const [sql, params] = dbMock.update.mock.calls[0];
    expect(String(sql)).toContain('`to_account` = ? AND `from_account` = ?');
    expect(params).toEqual([1, 2]);
  });
});

describe('the inbox', () => {
  it('answers nothing for a player with no accounts, without querying messages', async () => {
    dbMock.query.mockResolvedValueOnce([]);

    await expect(call('threads', { app: 'blabber' })).resolves.toEqual([]);
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

    const reply = await call('threads', { app: 'blabber' });

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

describe('the per-app policy (MICA-390)', () => {
  const notify = (from: { handle: string }, text: string) => ({
    title: `${from.handle} says`,
    message: text,
    deepLink: `testapp?with=${from.handle}`
  });

  it('refuses an app with no policy, before any read, on every action', async () => {
    // `data.app` is the payload's: default-allow would open DMs in any id a client names.
    for (const [action, data] of [
      ['send', { app: 'nopolicy', account_id: 1, peer_account_id: 2, body: 'hi' }],
      ['get', { app: 'nopolicy', account_id: 1, peer_account_id: 2 }],
      ['read', { app: 'nopolicy', account_id: 1, peer_account_id: 2 }],
      ['threads', { app: 'nopolicy' }]
    ] as const) {
      const reply = await call(action, data);
      expect(reply, action).toMatchObject({ key: 'server.dms.noPolicy' });
    }
    expect(dbMock.single).not.toHaveBeenCalled();
    expect(dbMock.query).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("asks the app's own accounts, in the app the payload names", async () => {
    registerDmPolicy('testapp', { canSend: () => true, notify });
    dbMock.single.mockResolvedValueOnce({ ...MY_ACCOUNT, app: 'testapp' });
    dbMock.single.mockResolvedValueOnce(PEER);

    await call('send', { app: 'testapp', account_id: 1, peer_account_id: 2, body: 'hi' });

    // ownedAccount, then activeAccount, both scoped to testapp rather than a constant.
    expect(dbMock.single.mock.calls[0][1]).toEqual([1, 'CIT_A', 'testapp']);
    expect(dbMock.single.mock.calls[1][1]).toEqual([2, 'testapp']);
  });

  it("refuses a send the app's canSend refuses, after the shared checks, and writes nothing", async () => {
    const canSend = vi.fn(() => false);
    registerDmPolicy('strictapp', { canSend, notify });
    dbMock.single.mockResolvedValueOnce({ ...MY_ACCOUNT, app: 'strictapp' });
    dbMock.single.mockResolvedValueOnce(PEER);

    const reply = await call('send', {
      app: 'strictapp',
      account_id: 1,
      peer_account_id: 2,
      body: 'hi'
    });

    // The block's words: a refusal does not say which rule it was.
    expect(reply).toMatchObject({ key: 'server.blabberDms.blocked' });
    expect(canSend).toHaveBeenCalledOnce();
    expect(canSend.mock.calls[0]).toEqual([
      expect.objectContaining({ id: 1 }),
      expect.objectContaining({ id: 2 })
    ]);
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(pushes()).toEqual([]);
  });

  it("pushes on the payload's app's channel, with that app's notice and deep link", async () => {
    registerDmPolicy('testapp', { canSend: () => true, notify });
    dbMock.single.mockResolvedValueOnce({ ...MY_ACCOUNT, app: 'testapp' });
    dbMock.single.mockResolvedValueOnce(PEER);

    const reply = await call('send', {
      app: 'testapp',
      account_id: 1,
      peer_account_id: 2,
      body: 'hi'
    });

    expect(reply).toMatchObject({ id: 70, from_account: 1, to_account: 2 });
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0]).toMatchObject({
      app: 'testapp',
      event: 'dm',
      payload: { peer_account_id: 1, handle: 'ada' },
      notify: { title: 'ada says', message: 'hi' },
      deepLink: 'testapp?with=ada'
    });
  });

  it('answers a committed send even when the notice throws', async () => {
    registerDmPolicy('testapp', {
      canSend: () => true,
      notify: () => {
        throw new Error('boom');
      }
    });
    dbMock.single.mockResolvedValueOnce({ ...MY_ACCOUNT, app: 'testapp' });
    dbMock.single.mockResolvedValueOnce(PEER);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const reply = await call('send', {
      app: 'testapp',
      account_id: 1,
      peer_account_id: 2,
      body: 'hi'
    });

    expect(reply).toMatchObject({ id: 70 });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('refuses a second policy for the same app', () => {
    registerDmPolicy('testapp', { canSend: () => true, notify });
    expect(() => registerDmPolicy('testapp', { canSend: () => true, notify })).toThrow(
      /already has a DM policy/
    );
    expect(() => registerDmPolicy('blabber', { canSend: () => true, notify })).toThrow(
      /already has a DM policy/
    );
  });

  it('reads an empty thread where canRead refuses, and the thread where it allows', async () => {
    let allow = false;
    registerDmPolicy('readapp', { canSend: () => true, canRead: () => allow, notify });
    const peerRow = { id: 2, app: 'readapp', handle: 'nightowl', citizenid: 'CIT_B' };

    dbMock.single.mockResolvedValueOnce({ ...MY_ACCOUNT, app: 'readapp' });
    dbMock.query.mockResolvedValueOnce([peerRow]);
    const refused = await call('get', { app: 'readapp', account_id: 1, peer_account_id: 2 });
    expect(refused).toEqual({ rows: [], nextCursor: null });
    // Only the peer lookup ran; the thread was never read.
    expect(dbMock.query).toHaveBeenCalledTimes(1);

    allow = true;
    dbMock.query.mockClear();
    dbMock.single.mockResolvedValueOnce({ ...MY_ACCOUNT, app: 'readapp' });
    dbMock.query.mockResolvedValueOnce([peerRow]);
    await call('get', { app: 'readapp', account_id: 1, peer_account_id: 2 });
    expect(String(dbMock.query.mock.calls[1][0])).toContain('FROM `mica_blabber_dms`');
  });
});

describe('deleteThread (MICA-390)', () => {
  it('deletes both directions unless the thread is held, then the reactions on what went', async () => {
    dbMock.query.mockResolvedValueOnce([{ id: 3 }, { id: 4 }]);
    dbMock.query.mockResolvedValueOnce({ affectedRows: 2 });
    dbMock.query.mockResolvedValueOnce({ affectedRows: 1 });

    expect(await deleteThread(1, 2)).toBe(2);

    const [select, remove, reactions] = dbMock.query.mock.calls;
    const threadHeld =
      'NOT EXISTS (SELECT 1 FROM (SELECT DISTINCT r.`id` FROM `mica_reports` r ' +
      'JOIN `mica_blabber_dms` d ON d.`id` = r.`target_id` WHERE r.`target_table` = ?';
    // Both directions, and the hold on the whole thread: an open report on any DM between the
    // two, not only on the candidate row.
    expect(String(select[0])).toContain('(t.`from_account` = ? AND t.`to_account` = ?)');
    expect(String(select[0])).toContain(threadHeld);
    expect(String(select[0])).toContain(
      'AND ((d.`from_account` = ? AND d.`to_account` = ?) OR (d.`from_account` = ? AND d.`to_account` = ?))'
    );
    expect(String(select[0])).not.toContain('r.`target_id` = t.`id`');
    expect(select[1]).toEqual([1, 2, 2, 1, 'mica_blabber_dms', 1, 2, 2, 1]);
    // The delete asks the hold again, so a report filed since the select still wins.
    expect(String(remove[0])).toMatch(/^DELETE FROM `mica_blabber_dms` WHERE `id` IN \(\?, \?\)/);
    expect(String(remove[0])).toContain(threadHeld);
    expect(remove[1]).toEqual([3, 4, 1, 2, 2, 1, 'mica_blabber_dms', 1, 2, 2, 1]);
    // Reactions only on rows actually gone.
    expect(String(reactions[0])).toContain('DELETE FROM `mica_account_reactions`');
    expect(String(reactions[0])).toContain('NOT EXISTS (SELECT 1 FROM `mica_blabber_dms` p');
    expect(reactions[1]).toEqual(['mica_blabber_dms', 3, 4]);
  });

  it('deletes nothing when the thread is held', async () => {
    dbMock.query.mockResolvedValueOnce([]);

    expect(await deleteThread(1, 2)).toBe(0);
    expect(dbMock.query).toHaveBeenCalledTimes(1);
  });

  it('refuses an id that is not one', async () => {
    await expect(deleteThread(0, 2)).rejects.toThrow(/not an account id/);
    await expect(deleteThread(1, Number.NaN)).rejects.toThrow(/not an account id/);
    expect(dbMock.query).not.toHaveBeenCalled();
  });
});
