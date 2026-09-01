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

const bridge = vi.hoisted(() => ({ current: 'PLAYER1' }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.current, source: 5, setMeta: () => {} }),
    getCitizenId: () => bridge.current,
    registerUsableItem: () => {}
  }
}));

/**
 * `resolveMany`, not `resolve`: the leaderboard resolves its ten names in one lookup rather
 * than one per row (MICA-197), so the mock has to be the batched shape or the assertion
 * below would pass against a `resolve` nothing calls any more.
 */
const directory = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('../lib/PlayerDirectory', () => ({
  resolveMany: vi.fn(async (citizenids: readonly string[]) => {
    directory.calls.push([...citizenids]);
    return new Map(
      citizenids.map((citizenid) => [
        citizenid,
        { citizenid, displayName: `Player ${citizenid}`, phone: null }
      ])
    );
  })
}));

import '../services/Highscores';

const PLAYER = 'PLAYER1';
const SRC = 5;

const call = async (action: string, data: unknown, citizenid = PLAYER) => {
  const handler = handlers.get(`gphone:server:highscores:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);

  bridge.current = citizenid;
  (globalThis as any).source = SRC;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  const reply = (globalThis.emitNet as any).mock.calls[0]?.[3];
  return reply;
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(1);
  dbMock.update.mockResolvedValue(true);
  dbMock.single.mockResolvedValue(null);
});

describe('highscores:submit', () => {
  it('rejects an unknown app', async () => {
    const reply = await call('submit', { app: 'not-a-real-game', score: 10 });
    expect(reply?.error).toBeTruthy();
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('rejects a negative score', async () => {
    const reply = await call('submit', { app: 'snek', score: -1 });
    expect(reply?.error).toBeTruthy();
  });

  it('rejects a non-integer score', async () => {
    const reply = await call('submit', { app: 'snek', score: 4.5 });
    expect(reply?.error).toBeTruthy();
  });

  it('rejects an implausibly large score', async () => {
    const reply = await call('submit', { app: 'snek', score: 100_000_000 });
    expect(reply?.error).toBeTruthy();
  });

  it('accepts score 0 (an immediate loss is a legitimate score)', async () => {
    const reply = await call('submit', { app: 'snek', score: 0 });
    expect(reply?.error).toBeUndefined();
    expect(dbMock.query).toHaveBeenCalledTimes(1);
  });

  it('upserts using the caller citizenid, and refuses a payload that names one', async () => {
    await call('submit', { app: 'snek', score: 50 }, PLAYER);
    const [, params] = dbMock.query.mock.calls[0];
    expect(params).toContain(PLAYER);

    dbMock.query.mockClear();
    const reply = await call(
      'submit',
      { app: 'snek', score: 50, citizenid: 'SOMEONE_ELSE' },
      PLAYER
    );

    // It was already unreadable — `upsertBest` takes the resolved citizenid and nothing
    // else. The contract turns "unread" into "refused", so the request does not succeed
    // while carrying a field the sender believed was doing something.
    expect(reply).toMatchObject({ error: expect.stringContaining('citizenid') });
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('never overwrites a higher stored score with a lower one, via GREATEST in SQL', async () => {
    await call('submit', { app: 'snek', score: 10 });
    const [sql] = dbMock.query.mock.calls[0];
    expect(sql).toMatch(/ON DUPLICATE KEY UPDATE/i);
    expect(sql).toMatch(/GREATEST/i);
  });
});

describe('highscores:top', () => {
  it('rejects an unknown app', async () => {
    const reply = await call('top', { app: 'not-a-real-game' });
    expect(reply?.error).toBeTruthy();
  });

  it('returns rows ordered by score with resolved display names', async () => {
    dbMock.query.mockResolvedValueOnce([
      { citizenid: 'A', score: 99 },
      { citizenid: 'B', score: 42 }
    ]);
    const reply = await call('top', { app: 'snek' });
    expect(reply).toEqual([
      { citizenid: 'A', score: 99, displayName: 'Player A' },
      { citizenid: 'B', score: 42, displayName: 'Player B' }
    ]);
  });

  /**
   * MICA-197. Every name used to be its own `resolve`, and `resolve` is a `LIMIT 1` query
   * for anybody not currently connected — so ten offline players on the board cost ten round
   * trips to render. One lookup for the whole board now, whatever is on it.
   */
  it('resolves every name in one lookup, not one per row', async () => {
    directory.calls.length = 0;
    dbMock.query.mockResolvedValueOnce([
      { citizenid: 'A', score: 99 },
      { citizenid: 'B', score: 42 },
      { citizenid: 'C', score: 7 }
    ]);

    await call('top', { app: 'snek' });

    expect(directory.calls).toEqual([['A', 'B', 'C']]);
  });

  /**
   * A score outlives the character that set it. A citizenid the framework has no record of
   * keeps its row with no name rather than falling off the board.
   */
  it('keeps a row whose citizenid resolves to nobody', async () => {
    dbMock.query.mockResolvedValueOnce([{ citizenid: 'GONE', score: 5 }]);
    const { resolveMany } = await import('../lib/PlayerDirectory');
    (resolveMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Map());

    const reply = await call('top', { app: 'snek' });

    expect(reply).toEqual([{ citizenid: 'GONE', score: 5, displayName: null }]);
  });
});
