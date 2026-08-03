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
    registerUsableItem: () => {}
  }
}));

import { blabber } from '../services/Blabber';

const call = async (action: string, data: unknown, citizenid = 'CIT_A') => {
  const handler = handlers.get(`gphone:server:blabber:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);
  bridge.current = citizenid;
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls[0]?.[3];
};

const MY_ACCOUNT = { id: 1, citizenid: 'CIT_A', app: 'blabber', handle: 'ada', status: 'active' };

beforeEach(() => {
  /**
   * `mockReset`, not just `clearAllMocks`.
   *
   * `clearAllMocks` drops recorded calls and leaves queued `mockResolvedValueOnce` values in
   * place. A test whose handler returns early never consumes the value it queued, so it shifts
   * the *next* test's queue by one and that test asserts against the wrong row — which shows up
   * as a security check appearing not to fire, rather than as anything that looks like a broken
   * mock.
   */
  vi.clearAllMocks();
  dbMock.single.mockReset();
  dbMock.insert.mockReset();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(50);
  dbMock.update.mockResolvedValue(true);
  dbMock.single.mockResolvedValue(null);
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
});

/**
 * Blabber, the first public table.
 *
 * The declaration assertions matter as much as the handler ones: this is the first thing in the
 * codebase whose rows are readable by players who do not own them, so what it *declares* is
 * what keeps a citizenid from crossing to a reader.
 */

describe('the declaration', () => {
  it('reads publicly and writes by owner', () => {
    expect(blabber.resolved.access).toEqual({ read: 'public', write: 'owner' });
  });

  it('withholds citizenid from every public read', () => {
    // On a feed this is the field that would correlate an alt back to whoever owns it.
    expect(blabber.resolved.publicColumns).not.toContain('citizenid');
    expect(blabber.resolved.publicColumns).toEqual(
      expect.arrayContaining(['id', 'account_id', 'body', 'reply_to'])
    );
  });

  it('declares paging, without which a public read returns the whole table', () => {
    expect(blabber.resolved.paging).toEqual({ pageSize: 30, maxPageSize: 60 });
  });

  it('time-boxes editing', () => {
    expect(blabber.resolved.editWindow).toBe(900);
  });

  it('lets an author edit only the body', () => {
    // account_id and reply_to are set at create and never after: either being writable would
    // let somebody reattribute their words to an alt, or re-parent them into another thread.
    expect(blabber.resolved.clientWritable).toEqual(['body']);
  });

  it('caps a Blab at 280 characters, server-side', () => {
    expect(blabber.resolved.columnRules.body).toMatchObject({ maxLength: 280 });
  });

  it('indexes what a public read filters on, without a citizenid prefix', () => {
    // `index: true` pairs a column with citizenid, which a public read never filters by.
    const names = blabber.resolved.indexes.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(['account_id', 'reply_to']));
    expect(names).not.toContain('citizenid_account_id');
  });
});

describe('posting', () => {
  it('accepts a post from an account the caller owns', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    const reply = await call('create', { account_id: 1, body: 'hello' });

    expect(reply).toMatchObject({ id: 50, account_id: 1, handle: 'ada', body: 'hello' });
  });

  it('refuses an account the caller does not own', async () => {
    // The account id is chosen by the client and proves nothing (§2.9). Without this check a
    // player posts as anyone's handle by guessing an id.
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('create', { account_id: 999, body: 'impersonation' });

    expect(reply.error).toMatch(/not yours to post from/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses an empty body', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    const reply = await call('create', { account_id: 1, body: '   ' });

    expect(reply.error).toMatch(/needs something in it/);
  });

  it('refuses a reply to a post that has been moderated', async () => {
    // Otherwise a client attaches a reply to removed content and resurrects it in a thread view.
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce({ id: 9, status: 'moderated' });

    const reply = await call('create', { account_id: 1, body: 'reviving this', reply_to: 9 });

    expect(reply.error).toMatch(/no longer available/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

describe('a profile feed', () => {
  it('splits Blabs from replies with a null check, not an equality filter', async () => {
    await call('profile', { account_id: 1, tab: 'blabs' });
    expect(String(dbMock.query.mock.calls[0][0])).toContain('`reply_to` IS NULL');

    dbMock.query.mockClear();
    await call('profile', { account_id: 1, tab: 'replies' });
    expect(String(dbMock.query.mock.calls[0][0])).toContain('`reply_to` IS NOT NULL');
  });

  it('never selects citizenid, even on a profile', async () => {
    await call('profile', { account_id: 1, tab: 'blabs' });

    const sql = String(dbMock.query.mock.calls[0][0]);
    expect(sql).not.toContain('citizenid');
  });

  it('keeps every payload value bound and clamps the page size', async () => {
    await call('profile', { account_id: 1, tab: 'blabs', cursor: 40, limit: 5000 });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('`id` < ?');
    // account id, cursor, then limit+1 clamped to maxPageSize.
    expect(params).toEqual([1, 40, 61]);
  });

  it('refuses a non-numeric account id', async () => {
    const reply = await call('profile', { account_id: '; DROP TABLE', tab: 'blabs' });

    expect(reply.error).toBeTruthy();
    expect(dbMock.query).not.toHaveBeenCalled();
  });
});
