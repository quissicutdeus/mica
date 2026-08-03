import { describe, it, expect, beforeEach, vi } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    scalar: vi.fn(),
    single: vi.fn()
  }
}));

vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { Repository } from '../lib/Repository';

interface TestRow {
  id: number;
  citizenid: string;
  title: string;
  content: string;
  status: string;
  created_at: string;
  updated_at: string;
}

class TestRepo extends Repository<TestRow> {
  protected tableName = 'gphone_test';
  protected columns = ['id', 'citizenid', 'title', 'content', 'status', 'created_at', 'updated_at'];
  protected clientWritable = ['title', 'content'];
  protected clientFilterable = ['title'];

  /** Surfaces the protected escape hatch so its behaviour is testable. */
  public exposeUpdateUnscoped(id: number, data: Partial<TestRow>): Promise<boolean> {
    return this.updateUnscoped(id, data);
  }
}

/** Framework-owned shape: no soft-delete column. */
class NoStatusRepo extends Repository<{ id: number; citizenid: string; amount: number }> {
  protected tableName = 'player_ledger';
  protected columns = ['id', 'citizenid', 'amount'];
}

/** Hypothetical shared table with no per-player owner. */
class NoOwnerRepo extends Repository<{ id: number; label: string; status: string }> {
  protected tableName = 'gphone_global';
  protected columns = ['id', 'label', 'status'];
  protected clientWritable = ['label'];
}

/** Declares fields it must never be granted, plus one that isn't a column. */
class OverreachingRepo extends Repository<TestRow> {
  protected tableName = 'gphone_test';
  protected columns = ['id', 'citizenid', 'title', 'status', 'created_at', 'updated_at'];
  protected clientWritable = [
    'id',
    'citizenid',
    'created_at',
    'updated_at',
    'status',
    'title',
    'not_a_column'
  ];
  protected clientFilterable = ['title', 'not_a_column'];
}

/** Collapse the whitespace the query builder inherits from template literals. */
const sqlOf = (call: unknown[] | undefined): string =>
  String(call?.[0]).replace(/\s+/g, ' ').trim();
const paramsOf = (call: unknown[] | undefined): unknown[] => call?.[1] as unknown[];

describe('Repository — SQL identifier allowlist', () => {
  let repo: TestRepo;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new TestRepo();
  });

  it('rejects a create payload key that is not a column', async () => {
    await expect(repo.create({ title: 'ok', evil: 1 } as any)).rejects.toThrow(
      /rejected unknown column 'evil'/
    );
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('rejects an injection-shaped key rather than splicing it into the statement', async () => {
    // A key crafted to break out of the identifier position and set a second column.
    const hostileKey = 'title` = ?, `citizenid';

    await expect(repo.create({ [hostileKey]: 'x' } as any)).rejects.toThrow(
      /rejected unknown column/
    );
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('rejects an unknown key on update and on findAll, not just create', async () => {
    await expect(repo.update(1, { evil: 1 } as any, 'CIT_A')).rejects.toThrow(
      /rejected unknown column 'evil'/
    );
    await expect(repo.findAll({ evil: 1 } as any)).rejects.toThrow(
      /rejected unknown column 'evil'/
    );
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('quotes identifiers and keeps every value parameterized, in key order', async () => {
    dbMock.insert.mockResolvedValue(42);

    const id = await repo.create({ title: 'Groceries', content: 'milk' } as Partial<TestRow>);

    expect(id).toBe(42);
    expect(sqlOf(dbMock.insert.mock.calls[0])).toBe(
      'INSERT INTO `gphone_test` (`title`, `content`) VALUES (?, ?)'
    );
    expect(paramsOf(dbMock.insert.mock.calls[0])).toEqual(['Groceries', 'milk']);
  });

  it('refuses an empty create payload instead of emitting invalid SQL', async () => {
    await expect(repo.create({})).rejects.toThrow(/requires at least one column/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses an empty update payload', async () => {
    await expect(repo.update(1, {}, 'CIT_A')).rejects.toThrow(/requires at least one column/);
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});

describe('Repository — ownership scoping', () => {
  let repo: TestRepo;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new TestRepo();
    dbMock.update.mockResolvedValue(true);
  });

  it('puts citizenid in the WHERE clause on update, so a row id alone is not authorization', async () => {
    await repo.update(7, { title: 'renamed' } as Partial<TestRow>, 'CIT_OWNER');

    expect(sqlOf(dbMock.update.mock.calls[0])).toBe(
      "UPDATE `gphone_test` SET `title` = ? WHERE `id` = ? AND `citizenid` = ? AND `status` != 'moderated'"
    );
    expect(paramsOf(dbMock.update.mock.calls[0])).toEqual(['renamed', 7, 'CIT_OWNER']);
  });

  it('refuses an update with no citizenid rather than falling back to an unscoped write', async () => {
    await expect(repo.update(7, { title: 'x' } as Partial<TestRow>, '')).rejects.toThrow(
      /requires a citizenid/
    );
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('refuses to scope a table that has no citizenid column', async () => {
    const shared = new NoOwnerRepo();

    await expect(shared.update(1, { label: 'x' }, 'CIT_A')).rejects.toThrow(
      /cannot scope by owner/
    );
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('omits the ownership predicate only through the protected escape hatch', async () => {
    await repo.exposeUpdateUnscoped(7, { status: 'deleted' } as Partial<TestRow>);

    expect(sqlOf(dbMock.update.mock.calls[0])).toBe(
      'UPDATE `gphone_test` SET `status` = ? WHERE `id` = ?'
    );
    expect(paramsOf(dbMock.update.mock.calls[0])).toEqual(['deleted', 7]);
  });

  it('keeps updateUnscoped off the public surface', () => {
    // The compile-time guarantee is `protected`; this pins the runtime shape so a
    // refactor cannot quietly widen it into a controller-reachable bypass.
    expect((repo as unknown as Record<string, unknown>).updateUnscoped).toBeTypeOf('function');
    expect(Object.keys(repo)).not.toContain('updateUnscoped');
  });
});

describe('Repository — soft delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.update.mockResolvedValue(true);
  });

  it('deletes by moving status, scoped to the owner', async () => {
    const repo = new TestRepo();

    const success = await repo.delete(9, 'CIT_OWNER');

    expect(success).toBe(true);
    expect(sqlOf(dbMock.update.mock.calls[0])).toBe(
      "UPDATE `gphone_test` SET `status` = ? WHERE `id` = ? AND `citizenid` = ? AND `status` != 'moderated'"
    );
    expect(paramsOf(dbMock.update.mock.calls[0])).toEqual(['deleted', 9, 'CIT_OWNER']);
  });

  it('never issues a hard DELETE', async () => {
    const repo = new TestRepo();
    await repo.delete(9, 'CIT_OWNER');

    expect(sqlOf(dbMock.update.mock.calls[0])).not.toMatch(/DELETE/i);
  });

  it('refuses to delete from a table with no status column', async () => {
    const ledger = new NoStatusRepo();

    await expect(ledger.delete(1, 'CIT_A')).rejects.toThrow(/requires a 'status' column/);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('requires a citizenid to delete', async () => {
    const repo = new TestRepo();

    await expect(repo.delete(9, '')).rejects.toThrow(/requires a citizenid/);
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});

describe('Repository — reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.query.mockResolvedValue([]);
    dbMock.single.mockResolvedValue(null);
  });

  it('defaults findAll to active rows', async () => {
    await new TestRepo().findAll({ citizenid: 'CIT_A' } as Partial<TestRow>);

    expect(sqlOf(dbMock.query.mock.calls[0])).toBe(
      'SELECT * FROM `gphone_test` WHERE `citizenid` = ? AND `status` = ?'
    );
    expect(paramsOf(dbMock.query.mock.calls[0])).toEqual(['CIT_A', 'active']);
  });

  it('does not override an explicitly requested status', async () => {
    await new TestRepo().findAll({ citizenid: 'CIT_A', status: 'archived' } as Partial<TestRow>);

    expect(paramsOf(dbMock.query.mock.calls[0])).toEqual(['CIT_A', 'archived']);
  });

  it('skips the implicit status filter on tables without the column', async () => {
    await new NoStatusRepo().findAll({ citizenid: 'CIT_A' });

    expect(sqlOf(dbMock.query.mock.calls[0])).toBe(
      'SELECT * FROM `player_ledger` WHERE `citizenid` = ?'
    );
    expect(paramsOf(dbMock.query.mock.calls[0])).toEqual(['CIT_A']);
  });

  it('emits no WHERE clause when there is nothing to filter on', async () => {
    await new NoStatusRepo().findAll();

    expect(sqlOf(dbMock.query.mock.calls[0])).toBe('SELECT * FROM `player_ledger`');
    expect(paramsOf(dbMock.query.mock.calls[0])).toEqual([]);
  });

  it('scopes findById by owner when a citizenid is supplied', async () => {
    await new TestRepo().findById(3, 'CIT_OWNER');

    expect(sqlOf(dbMock.single.mock.calls[0])).toBe(
      'SELECT * FROM `gphone_test` WHERE `id` = ? AND `citizenid` = ?'
    );
    expect(paramsOf(dbMock.single.mock.calls[0])).toEqual([3, 'CIT_OWNER']);
  });

  it('leaves findById unscoped for server-internal reads', async () => {
    await new TestRepo().findById(3);

    expect(sqlOf(dbMock.single.mock.calls[0])).toBe('SELECT * FROM `gphone_test` WHERE `id` = ?');
    expect(paramsOf(dbMock.single.mock.calls[0])).toEqual([3]);
  });

  it('refuses to scope findById on a table with no owner column', async () => {
    await expect(new NoOwnerRepo().findById(3, 'CIT_A')).rejects.toThrow(/cannot scope by owner/);
    expect(dbMock.single).not.toHaveBeenCalled();
  });
});

describe('Repository — declared client policy', () => {
  it('subtracts the never-writable columns even when a repository declares them', () => {
    expect(new OverreachingRepo().writableColumns).toEqual(['status', 'title']);
  });

  it('drops declared names that are not real columns', () => {
    const repo = new OverreachingRepo();

    expect(repo.writableColumns).not.toContain('not_a_column');
    expect(repo.filterableColumns).toEqual(['title']);
  });

  it('exposes the column list for callers that need to reason about the table', () => {
    expect(new TestRepo().tableColumns).toContain('citizenid');
  });
});

/**
 * Keyset paging.
 *
 * Ordered by `id DESC` and not configurable — see `PagingDefinition`. These lock the parts
 * that are easy to get subtly wrong and impossible to notice: the strictness of the cursor
 * comparison, and the promise that an unpaged read is untouched.
 */
describe('Repository: keyset paging', () => {
  beforeEach(() => {
    dbMock.query.mockReset();
    dbMock.query.mockResolvedValue([]);
  });

  it('emits byte-identical SQL when no page is asked for', async () => {
    // The guarantee the whole optional-argument shape exists to keep. Owner-scoped reads are
    // already bounded by their citizenid predicate, several repositoryFactory subclasses call
    // super.findAll(where), and adding an unconditional ORDER BY would change all of them.
    await new TestRepo().findAll({ citizenid: 'CIT_A' } as never);

    expect(dbMock.query.mock.calls[0][0]).toBe(
      'SELECT * FROM `gphone_test` WHERE `citizenid` = ? AND `status` = ?'
    );
    expect(dbMock.query.mock.calls[0][0]).not.toContain('ORDER BY');
    expect(dbMock.query.mock.calls[0][0]).not.toContain('LIMIT');
  });

  it('orders by the primary key descending, and limits, when paged', async () => {
    await new TestRepo().findAll({} as never, { limit: 30 });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(sql).toBe('SELECT * FROM `gphone_test` WHERE `status` = ? ORDER BY `id` DESC LIMIT ?');
    expect(params).toEqual(['active', 30]);
  });

  it('compares the cursor strictly, so a page boundary does not repeat a row', async () => {
    // `id <= ?` would re-deliver the row the previous page ended on, once per page, forever.
    await new TestRepo().findAll({} as never, { limit: 10, cursor: 500 });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(sql).toContain('`id` < ?');
    expect(sql).not.toContain('`id` <= ?');
    expect(params).toEqual(['active', 500, 10]);
  });

  it('keeps the cursor bound rather than interpolated', async () => {
    // A cursor is client-supplied. It is a value, so it parameterizes; the only identifier
    // in the ORDER BY comes from the declaration, never from the payload.
    await new TestRepo().findAll({} as never, { limit: 5, cursor: 42 });

    expect(dbMock.query.mock.calls[0][0]).not.toContain('42');
    expect(dbMock.query.mock.calls[0][1]).toContain(42);
  });

  it('pages a table with no other filter at all', async () => {
    // A public feed with no status column and no owner predicate: the cursor has to be able
    // to open the WHERE clause on its own rather than assuming something precedes it.
    await new NoStatusRepo().findAll({} as never, { limit: 20, cursor: 7 });

    expect(dbMock.query.mock.calls[0][0]).toBe(
      'SELECT * FROM `player_ledger` WHERE `id` < ? ORDER BY `id` DESC LIMIT ?'
    );
  });
});
