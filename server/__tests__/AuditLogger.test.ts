import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { AuditLogger } from '../lib/AuditLogger';

/**
 * The moderation ledger. It is the only record that a decision was made, and it is
 * written on the success path of deletes and moderations — so if it silently stops
 * working, nothing else changes and nobody notices until somebody asks who removed
 * something.
 */

const params = () => dbMock.insert.mock.calls[0][1];

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.insert.mockResolvedValue(1);
});

describe('AuditLogger', () => {
  it('writes the columns in the order the statement declares', async () => {
    // A positional INSERT: swapping two same-typed columns is silent and puts the
    // service in the action column for every row written from then on.
    await AuditLogger.log({
      citizenid: 'CIT_A',
      action: 'moderated',
      service: 'reports',
      method: 'resolve',
      targetId: 42,
      targetTable: 'gphone_photos'
    });

    const sql = String(dbMock.insert.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('(citizenid, action, service, method, target_id, target_table, details)');
    expect(params()).toEqual([
      'CIT_A',
      'moderated',
      'reports',
      'resolve',
      42,
      'gphone_photos',
      null
    ]);
  });

  it('serialises details, and writes null rather than "undefined"', async () => {
    await AuditLogger.log({
      citizenid: 'CIT_A',
      action: 'deleted',
      service: 'contacts',
      method: 'delete',
      targetId: 1,
      details: { reason: 'spam' }
    });
    expect(params()[6]).toBe('{"reason":"spam"}');

    dbMock.insert.mockClear();
    await AuditLogger.log({
      citizenid: 'CIT_A',
      action: 'deleted',
      service: 'contacts',
      method: 'delete',
      targetId: 1
    });
    expect(params()[6]).toBeNull();
    expect(params()[5]).toBeNull();
  });

  it('reports failure instead of throwing into the caller', async () => {
    // Deliberate: an audit write that fails must not roll back or abort the moderation
    // it is recording. The caller gets `false` and the row is already gone.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.insert.mockRejectedValue(new Error('table missing'));

    await expect(
      AuditLogger.log({
        citizenid: 'CIT_A',
        action: 'deleted',
        service: 'contacts',
        method: 'delete',
        targetId: 1
      })
    ).resolves.toBe(false);

    expect(error).toHaveBeenCalled();
  });

  it('says it succeeded only when the insert did', async () => {
    await expect(
      AuditLogger.log({
        citizenid: 'CIT_A',
        action: 'unmoderated',
        service: 'reports',
        method: 'reopen',
        targetId: 3
      })
    ).resolves.toBe(true);
  });
});
