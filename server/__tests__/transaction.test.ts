import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Database } from '../lib/Database';

describe('Database.transaction', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true immediately for empty query list', async () => {
    const res = await Database.transaction([]);
    expect(res).toBe(true);
  });

  it('formats queries and parameters correctly for oxmysql.transaction_async', async () => {
    const oxmysql = (globalThis as any).exports.oxmysql;
    const spy = vi.spyOn(oxmysql, 'transaction_async').mockResolvedValue(true);

    const queries = [
      { query: 'INSERT INTO table_a (col) VALUES (?)', params: ['val1'] },
      { query: 'UPDATE table_b SET col = ? WHERE id = ?', params: ['val2', 10] }
    ];

    const result = await Database.transaction(queries);

    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledWith([
      { query: 'INSERT INTO table_a (col) VALUES (?)', values: ['val1'] },
      { query: 'UPDATE table_b SET col = ? WHERE id = ?', values: ['val2', 10] }
    ]);
  });

  it('defaults empty params array when params is omitted', async () => {
    const oxmysql = (globalThis as any).exports.oxmysql;
    const spy = vi.spyOn(oxmysql, 'transaction_async').mockResolvedValue(true);

    await Database.transaction([{ query: 'DELETE FROM temp_table' }]);

    expect(spy).toHaveBeenCalledWith([{ query: 'DELETE FROM temp_table', values: [] }]);
  });
});
