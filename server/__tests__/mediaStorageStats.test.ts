// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

const bridge = vi.hoisted(() => ({ citizenid: 'CID_A' }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.citizenid, source: 5, setMeta: () => {} }),
    getSourceByCitizenId: () => 5,
    getSourcesByCitizenId: () => new Map(),
    registerUsableItem: () => {}
  }
}));

vi.mock('../lib/proximity', () => ({ findNearbyVisiblePlayers: vi.fn(async () => []) }));

import { media, mediaStorageStats, runMediaStatsCommand } from '../services/Media';

// MICA-71: reference the imported service so this suite's side-effecting import of
// `../services/Media` (RegisterCommand at module scope) is not tree-shaken away.
const repo = media.repo;
void repo;

const notifies = () =>
  (globalThis.emitNet as any).mock.calls.filter((c: any[]) => c[0] === 'gos:client:shell:notify');

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.emitNet = vi.fn() as any;
  (globalThis as any).GetConvar = (_n: string, fallback: string) => fallback;
  (globalThis as any).IsPlayerAceAllowed = () => false;
});

describe('mediaStorageStats', () => {
  it('reads totals and top holders straight from LENGTH(data)/LENGTH(thumbnail), not byte_size', async () => {
    dbMock.single.mockResolvedValue({ rowCount: 42, totalBytes: 123456 });
    dbMock.query.mockResolvedValue([
      { citizenid: 'CID_A', rowCount: 10, bytes: 90000 },
      { citizenid: 'CID_B', rowCount: 5, bytes: 33456 }
    ]);

    const stats = await mediaStorageStats();

    expect(stats).toEqual({
      rowCount: 42,
      totalBytes: 123456,
      topHolders: [
        { citizenid: 'CID_A', rowCount: 10, bytes: 90000 },
        { citizenid: 'CID_B', rowCount: 5, bytes: 33456 }
      ]
    });
    expect(dbMock.single.mock.calls[0][0]).toMatch(/LENGTH\(data\)/);
    expect(dbMock.single.mock.calls[0][0]).not.toMatch(/byte_size/);
  });

  it('treats a null aggregate (an empty table) as zero rather than NaN', async () => {
    dbMock.single.mockResolvedValue({ rowCount: 0, totalBytes: null });
    dbMock.query.mockResolvedValue([]);

    const stats = await mediaStorageStats();

    expect(stats).toEqual({ rowCount: 0, totalBytes: 0, topHolders: [] });
  });
});

describe('gosmedia command', () => {
  beforeEach(() => {
    dbMock.single.mockResolvedValue({ rowCount: 1, totalBytes: 1000 });
    dbMock.query.mockResolvedValue([{ citizenid: 'CID_A', rowCount: 1, bytes: 1000 }]);
  });

  it('refuses a player with no admin ace, and says so', async () => {
    await runMediaStatsCommand(7);

    expect(notifies()[0]?.[2]).toMatchObject({ type: 'error' });
  });

  it('runs for the console with no ace needed', async () => {
    await runMediaStatsCommand(0);

    // The console gets nothing over emitNet -- the report goes to its own stdout.
    expect(notifies()).toHaveLength(0);
  });

  it('reports success to an in-game admin, not just the console', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;

    await runMediaStatsCommand(7);

    expect(notifies()[0]?.[2]).toMatchObject({ type: 'success' });
  });
});
