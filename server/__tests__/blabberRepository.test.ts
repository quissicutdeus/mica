import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  query: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  scalar: vi.fn(),
  single: vi.fn()
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { blabber } from '../services/Blabber';
import type { BlabberRepository } from '../repositories/BlabberRepository';

const repo = blabber.repo as BlabberRepository;

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  account_id: 1,
  body: `blab ${id}`,
  reply_to: null,
  mouth_of: null,
  root_id: 100,
  status: 'active',
  ...over
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
});

describe('findFlattenedPage', () => {
  it('without a cursor or anchor, returns the newest replies first', async () => {
    dbMock.query
      .mockResolvedValueOnce([row(105), row(104), row(103)]) // replies (author query separate)
      .mockResolvedValueOnce([]); // author lookup, no authors needed for this assertion

    const page = await repo.findFlattenedPage(100, { limit: 30, cursor: null, anchorId: null });

    expect(page.rows.map((r) => r.id)).toEqual([105, 104, 103]);
    expect(page.nextCursor).toBeNull();

    // `reply_to` legitimately appears in the SELECT projection (it's a public column on every
    // Blab), so the thing worth pinning down is that the WHERE clause flattens by `root_id`
    // rather than filtering to direct children via a `reply_to` equality.
    const sql = String(dbMock.query.mock.calls[0][0]);
    expect(sql).toContain('`root_id` = ?');
    expect(sql).not.toContain('`reply_to` =');
  });

  it('paginates with nextCursor when more rows exist than the limit', async () => {
    // limit 2 requested; repository asks for limit+1 to detect more.
    dbMock.query.mockResolvedValueOnce([row(105), row(104), row(103)]).mockResolvedValueOnce([]);

    const page = await repo.findFlattenedPage(100, { limit: 2, cursor: null, anchorId: null });

    expect(page.rows.map((r) => r.id)).toEqual([105, 104]);
    expect(page.nextCursor).toBe(104);
  });

  it('honors a cursor for a continuation page, ignoring any anchor', async () => {
    dbMock.query.mockResolvedValueOnce([row(102), row(101)]).mockResolvedValueOnce([]);

    await repo.findFlattenedPage(100, { limit: 30, cursor: 103, anchorId: 999 });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('id` < ?');
    expect(params).toContain(103);
  });

  it('with an anchor and no cursor, centers the window on the anchor row', async () => {
    // Two queries split the window: newer-than-anchor ascending (LIMIT = ceil(limit/2) = 3 for
    // limit 6), then the anchor-and-older descending (LIMIT = limit - newer.length + 1). The
    // fixtures below return fewer rows than each LIMIT asks for, which is realistic near the
    // start of a thread and keeps the assertion about shape rather than exact counts.
    dbMock.query
      .mockResolvedValueOnce([row(101), row(102)]) // newer than anchor 100, ascending
      .mockResolvedValueOnce([row(100), row(99), row(98)]) // anchor (100) and older, descending
      .mockResolvedValueOnce([]); // authors

    const page = await repo.findFlattenedPage(100, { limit: 6, cursor: null, anchorId: 100 });

    // Merged back into id DESC: newer (reversed to descending) then the anchor-and-older page.
    expect(page.rows.map((r) => r.id)).toEqual([102, 101, 100, 99, 98]);
  });
});
