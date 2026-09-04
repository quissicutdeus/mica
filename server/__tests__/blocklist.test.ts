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
    expect(String(sql)).toBe('INSERT INTO `mica_blocklist` (`number`, `citizenid`) VALUES (?, ?)');
    expect(params).toEqual(['555-0100', 'CIT_A']);
  });

  it('scopes get and delete to the caller citizenid', async () => {
    await call('get', {});
    expect(dbMock.query.mock.calls[0][1]).toEqual(['CIT_A', 'active']);

    await call('delete', { id: 7 });
    expect(dbMock.update.mock.calls[0][1]).toEqual(['deleted', 7, 'CIT_A']);
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
  it('is unique per citizenid and number', () => {
    expect(blocklist.resolved.indexes).toContainEqual(
      expect.objectContaining({ columns: ['citizenid', 'number'], unique: true })
    );
  });
});
