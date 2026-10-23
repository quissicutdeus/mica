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

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(101);
  dbMock.update.mockResolvedValue(true);
  dbMock.scalar.mockResolvedValue(null);
});

describe('blocklist — the declaration', () => {
  it.each(['get', 'create', 'update', 'delete'])(
    'registers no generic %s — nothing in the phone calls it (MICA-414)',
    (action) => {
      expect(handlers.has(`mica:server:blocklist:${action}`)).toBe(false);
    }
  );

  it('still declares the table the enforcement reads', () => {
    expect(blocklist.resolved.table).toBe('mica_blocklist');
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
  it('is unique per phone and number, while the block is not erased', () => {
    // Per phone since MICA-282: each phone keeps its own list, so the key names the device —
    // through `live_device` since MICA-428, which an erased block does not carry.
    expect(blocklist.resolved.indexes).toContainEqual(
      expect.objectContaining({ columns: ['live_device', 'number'], unique: true })
    );
    const live = blocklist.resolved.fields.find((f) => f.name === 'live_device')?.def;
    expect(live?.generatedAs).toBe("CASE WHEN `status` <> 'erased' THEN `device_id` ELSE NULL END");
  });
});
