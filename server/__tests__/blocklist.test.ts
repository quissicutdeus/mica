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

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: 'CIT_A', source: 5, setMeta: () => {} })
  }
}));

import { blocklist, isBlocked } from '../services/Blocklist';
import { __resetRateLimits } from '../lib/rateLimit';
import { TEST_PHONE_ID } from './phoneStub';

const call = async (action: string, data: unknown) => {
  const handler = handlers.get(`mica:server:blocklist:${action}`);
  if (!handler) throw new Error(`no handler for blocklist:${action}`);
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(101);
  dbMock.update.mockResolvedValue(true);
  dbMock.scalar.mockResolvedValue(null);
});

describe('blocklist — the declaration', () => {
  it('registers get/create/delete but not the generic update', () => {
    expect(handlers.has('mica:server:blocklist:get')).toBe(true);
    expect(handlers.has('mica:server:blocklist:create')).toBe(true);
    expect(handlers.has('mica:server:blocklist:delete')).toBe(true);
    expect(handlers.has('mica:server:blocklist:update')).toBe(false);
  });

  it('scopes create to the caller citizenid, never one the payload names', async () => {
    await call('create', { number: '555-0100', citizenid: 'CIT_VICTIM' });

    const [sql, params] = dbMock.insert.mock.calls[0];
    // The phone beside the citizen (MICA-282): stamped by the server, never from the payload.
    expect(String(sql)).toBe(
      'INSERT INTO `mica_blocklist` (`number`, `citizenid`, `phone_id`) VALUES (?, ?, ?)'
    );
    expect(params).toEqual(['555-0100', 'CIT_A', TEST_PHONE_ID]);
  });

  it('scopes get and delete to the caller citizenid', async () => {
    await call('get', {});
    expect(dbMock.query.mock.calls[0][1]).toEqual(['CIT_A', TEST_PHONE_ID, 'active']);

    await call('delete', { id: 7 });
    expect(dbMock.update.mock.calls[0][1]).toEqual(['deleted', 7, 'CIT_A', TEST_PHONE_ID]);
  });
});

describe('isBlocked (MICA-64)', () => {
  it('asks against the normalised number and the given citizenid', async () => {
    await isBlocked('CIT_A', ' 555-0100 ');

    expect(dbMock.scalar).toHaveBeenCalledWith(expect.stringContaining('mica_blocklist'), [
      'CIT_A',
      '555-0100'
    ]);
  });

  it('answers true when a row is found', async () => {
    dbMock.scalar.mockResolvedValue(1);
    await expect(isBlocked('CIT_A', '555-0100')).resolves.toBe(true);
  });

  it('answers false when no row is found', async () => {
    dbMock.scalar.mockResolvedValue(null);
    await expect(isBlocked('CIT_A', '555-0100')).resolves.toBe(false);
  });

  it('answers false without querying at all for a number that does not normalise', async () => {
    await expect(isBlocked('CIT_A', '')).resolves.toBe(false);
    expect(dbMock.scalar).not.toHaveBeenCalled();
  });

  it('only counts an active block, matching the query filter', async () => {
    // The SQL itself carries `status = 'active'` — this pins that the filter is present
    // in the statement rather than only in this suite's mental model of it.
    await isBlocked('CIT_A', '555-0100');
    const [sql] = dbMock.scalar.mock.calls[0];
    expect(sql).toMatch(/status`\s*=\s*'active'/);
  });
});

describe('blocklist schema', () => {
  it('is unique per phone and number', () => {
    // Per phone since MICA-282: each phone keeps its own list, so the key names the device.
    expect(blocklist.resolved.indexes).toContainEqual(
      expect.objectContaining({ columns: ['phone_id', 'number'], unique: true })
    );
  });
});

/**
 * Block, unblock, block again (MICA-318), against a stand-in for the table that keeps
 * `phone_number_unique` the way MariaDB does — the mocked `Database` above answers every
 * insert, so it could not see the duplicate-key refusal this is about. The stand-in reads
 * the statements the repository sends and nothing else; a statement it does not know fails
 * the test rather than answering.
 */
describe('blocklist — a number blocked again after an unblock (MICA-318)', () => {
  interface Row {
    id: number;
    citizenid: string;
    phone_id: string | null;
    number: string;
    status: string;
  }
  let rows: Row[];
  const OTHER_PHONE = 'fedcba9876543210fedcba9876543210';

  beforeEach(() => {
    rows = [];
    dbMock.insert.mockImplementation(async (sql: string, params: unknown[]) => {
      expect(sql).toBe(
        'INSERT INTO `mica_blocklist` (`number`, `citizenid`, `phone_id`) VALUES (?, ?, ?)'
      );
      const [number, citizenid, phone_id] = params as [string, string, string];
      if (rows.some((r) => r.phone_id === phone_id && r.number === number)) {
        throw new Error(`Duplicate entry '${phone_id}-${number}' for key 'phone_number_unique'`);
      }
      const id = rows.length + 1;
      rows.push({ id, citizenid, phone_id, number, status: 'active' });
      return id;
    });
    dbMock.scalar.mockImplementation(async (sql: string, params: unknown[]) => {
      expect(sql).toMatch(/^SELECT `id` FROM `mica_blocklist` WHERE `citizenid` = \?/);
      expect(sql).toContain("`status` = 'deleted'");
      const [citizenid, phone_id, number] = params as string[];
      const hit = rows.find(
        (r) =>
          r.citizenid === citizenid &&
          r.phone_id === phone_id &&
          r.number === number &&
          r.status === 'deleted'
      );
      return hit ? hit.id : null;
    });
    dbMock.update.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("SET `status` = 'active'")) {
        const [id, citizenid, phone_id] = params as [number, string, string];
        const hit = rows.find(
          (r) =>
            r.id === id &&
            r.citizenid === citizenid &&
            r.phone_id === phone_id &&
            r.status === 'deleted'
        );
        if (hit) hit.status = 'active';
        return Boolean(hit);
      }
      expect(sql).toContain('SET `status` = ?');
      const [status, id, citizenid, phone_id] = params as [string, number, string, string];
      const hit = rows.find(
        (r) =>
          r.id === id &&
          r.citizenid === citizenid &&
          r.phone_id === phone_id &&
          r.status !== 'moderated'
      );
      if (hit) hit.status = status;
      return Boolean(hit);
    });
  });

  it('blocks, unblocks and blocks again, reviving the one row', async () => {
    const first = await call('create', { number: '5550100' });
    expect(first?.id).toBe(1);
    expect(await call('delete', { id: first.id })).toBe(true);
    expect(rows[0].status).toBe('deleted');

    const again = await call('create', { number: '5550100' });
    expect(again?.error).toBeUndefined();
    expect(again?.id).toBe(1);
    expect(rows).toEqual([
      { id: 1, citizenid: 'CIT_A', phone_id: TEST_PHONE_ID, number: '5550100', status: 'active' }
    ]);

    // And the revived block lifts again, by the id the second create answered.
    expect(await call('delete', { id: again.id })).toBe(true);
    expect(rows[0].status).toBe('deleted');
  });

  it('refreshes created_at on the revived row, as a new block would set it', async () => {
    const first = await call('create', { number: '5550100' });
    await call('delete', { id: first.id });
    await call('create', { number: '5550100' });
    const revive = dbMock.update.mock.calls.find(([sql]) => String(sql).includes("'active'"));
    expect(String(revive?.[0])).toContain('`created_at` = CURRENT_TIMESTAMP');
  });

  it("never revives another owner's row under the same key", async () => {
    // The phone's previous holder unblocked the number and the rows have not followed the
    // phone yet: the key is held by a row this caller does not own.
    rows.push({
      id: 1,
      citizenid: 'CIT_B',
      phone_id: TEST_PHONE_ID,
      number: '5550100',
      status: 'deleted'
    });

    const reply = await call('create', { number: '5550100' });
    expect(typeof reply?.error).toBe('string');
    expect(rows).toEqual([
      { id: 1, citizenid: 'CIT_B', phone_id: TEST_PHONE_ID, number: '5550100', status: 'deleted' }
    ]);
  });

  it("never revives the same citizen's row on another phone", async () => {
    rows.push({
      id: 1,
      citizenid: 'CIT_A',
      phone_id: OTHER_PHONE,
      number: '5550100',
      status: 'deleted'
    });

    const reply = await call('create', { number: '5550100' });
    expect(reply?.id).toBe(2);
    expect(rows.map((r) => [r.phone_id, r.status])).toEqual([
      [OTHER_PHONE, 'deleted'],
      [TEST_PHONE_ID, 'active']
    ]);
  });

  it('names the session citizen and phone in the lookup, never the payload', async () => {
    await call('create', { number: '5550100', citizenid: 'CIT_B', phone_id: OTHER_PHONE });
    expect(dbMock.scalar.mock.calls[0][1]).toEqual(['CIT_A', TEST_PHONE_ID, '5550100']);
  });
});
