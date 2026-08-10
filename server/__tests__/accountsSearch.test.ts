import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, handlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  (globalThis as any).onNet = (event: string, handler: Function) => captured.set(event, handler);
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: 'CIT_A', source: 5, setMeta: () => {} }),
    getCitizenId: () => 'CIT_A',
    registerUsableItem: () => {}
  }
}));

import '../services/Accounts';

const call = async (data: unknown) => {
  const handler = handlers.get('gphone:server:accounts:search');
  if (!handler) throw new Error('accounts:search is not registered');
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls[0]?.[3];
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
});

describe('accounts:search', () => {
  it('binds the query rather than interpolating it', async () => {
    await call({ app: 'blabber', q: "ada' OR '1'='1" });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).not.toContain("OR '1'='1");
    expect(params).toContain(`%ada' OR '1'='1%`);
  });

  it('scopes to the requested app', async () => {
    await call({ app: 'blabber', q: 'ada' });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('`app` = ?');
    expect(params).toContain('blabber');
  });

  it('never selects citizenid', async () => {
    await call({ app: 'blabber', q: 'ada' });

    const sql = String(dbMock.query.mock.calls[0][0]);
    expect(sql).not.toContain('citizenid');
  });

  it('requires an app id', async () => {
    const reply = await call({ q: 'ada' });
    expect(reply.error).toBeTruthy();
  });

  it('paginates with a keyset cursor on id DESC', async () => {
    dbMock.query.mockResolvedValueOnce(
      Array.from({ length: 4 }, (_, i) => ({ id: 10 - i, handle: `h${i}` }))
    );

    const reply = await call({ app: 'blabber', q: 'ad', limit: 3 });

    expect(reply.rows).toHaveLength(3);
    expect(reply.nextCursor).toBe(8);
  });
});
