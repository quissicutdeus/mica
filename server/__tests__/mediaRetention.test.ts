import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * MICA-71: the per-player quota, the retention prune, and the cleanup that runs when a
 * character is gone.
 *
 * Three things this suite is deliberately careful about, because each is a way it could
 * pass while proving nothing:
 *
 * - **Both convars are read through `GetConvarInt`, which `setup.ts` does not stub.** The
 *   production code guards on `typeof GetConvarInt === 'function'`, so a suite that never
 *   defines it exercises only the fallback path. It is defined here, per test.
 * - **A `DELETE` is asserted on its SQL, not just on its call count.** A prune that
 *   deleted the whole table would satisfy "it called query once".
 * - **The startup sweep now hangs off `onResourceStart`**, which `setup.ts` stubs as a
 *   noop, so importing this module runs no maintenance and the tests below drive the
 *   exported functions directly.
 */
const { dbMock, handlers, localHandlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const local = new Map<string, Function>();

  const previousNet = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previousNet === 'function' ? previousNet(event, handler) : undefined;
  };

  const previousOn = (globalThis as any).on;
  (globalThis as any).on = (event: string, handler: Function) => {
    local.set(event, handler);
    return typeof previousOn === 'function' ? previousOn(event, handler) : undefined;
  };

  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured,
    localHandlers: local
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

const bridge = vi.hoisted(() => ({ citizenid: 'CID_A', online: {} as Record<string, number> }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.citizenid, source: 5, setMeta: () => {} }),
    getSourceByCitizenId: () => 5,
    getSourcesByCitizenId: (citizenids: readonly string[]) =>
      new Map(
        citizenids.filter((cid) => cid in bridge.online).map((cid) => [cid, bridge.online[cid]])
      ),
    registerUsableItem: () => {}
  }
}));

const proximity = vi.hoisted(() => ({ nearby: [] as { source: number; citizenid: string }[] }));
vi.mock('../lib/proximity', () => ({
  findNearbyVisiblePlayers: vi.fn(async () => proximity.nearby)
}));

import {
  pruneExpiredMedia,
  pruneOrphanedMedia,
  purgeMediaForCitizen,
  runMediaMaintenance,
  runMediaPruneCommand
} from '../services/Media';

const CREATE_EVENT = 'gphone:server:media:create';
const DROP_EVENT = 'gphone:server:media:drop';
const CHARACTER_DELETED_EVENT = 'gphone:server:media:characterDeleted';

const MB = 1024 * 1024;

const call = async (event: string, data: unknown) => {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`no handler for ${event}`);
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

/** Neither convar set: both fall back to their compiled-in defaults. */
const withConvars = (values: Record<string, number> = {}) => {
  (globalThis as any).GetConvarInt = (name: string, fallback: number) =>
    name in values ? values[name] : fallback;
};

const photoOf = (bytes: number) => `data:image/webp;base64,${'A'.repeat(bytes)}`;

const OWNED_ROW = {
  id: 42,
  citizenid: 'CID_A',
  kind: 'photo',
  data: photoOf(1 * MB),
  url: null,
  thumbnail: null,
  mime_type: null,
  width: null,
  height: null,
  duration_ms: null,
  byte_size: null,
  alt_text: null,
  status: 'active'
};

/** The last SQL string handed to `Database.query`, whitespace flattened. */
const lastQuery = (): string =>
  String(dbMock.query.mock.calls.at(-1)?.[0] ?? '').replace(/\s+/g, ' ');

const queries = (): string[] =>
  dbMock.query.mock.calls.map((c: unknown[]) => String(c[0]).replace(/\s+/g, ' '));

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.single.mockReset();
  dbMock.query.mockReset();
  dbMock.insert.mockReset();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(99);
  bridge.citizenid = 'CID_A';
  bridge.online = { CID_B: 9, CID_C: 11 };
  proximity.nearby = [];
  withConvars();
  (globalThis as any).IsPlayerAceAllowed = () => false;
  (globalThis as any).emitNet = vi.fn();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the per-player quota (MICA-71)', () => {
  it('measures the library the same way gphonemedia reports it', async () => {
    dbMock.single.mockResolvedValue({ bytes: 0 });

    await call(CREATE_EVENT, { kind: 'photo', data: photoOf(1024) });

    const sql = String(dbMock.single.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('LENGTH(data)');
    expect(sql).toContain('LENGTH(thumbnail)');
    // The bound, not the whole table: a quota that ignored the owner would be a global cap.
    expect(sql).toContain('citizenid = ?');
    expect(dbMock.single.mock.calls[0][1]).toEqual(['CID_A']);
  });

  it("counts only the player's active rows, so deleting a photo frees room at once", async () => {
    dbMock.single.mockResolvedValue({ bytes: 0 });

    await call(CREATE_EVENT, { kind: 'photo', data: photoOf(1024) });

    expect(String(dbMock.single.mock.calls[0][0])).toContain("status = 'active'");
  });

  it('lets an ordinary capture through when the library has room', async () => {
    dbMock.single.mockResolvedValue({ bytes: 10 * MB });

    const reply = await call(CREATE_EVENT, { kind: 'photo', data: photoOf(400 * 1024) });

    expect(reply.error).toBeUndefined();
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it('refuses a capture that would cross the ceiling, and writes nothing', async () => {
    dbMock.single.mockResolvedValue({ bytes: 64 * MB });

    const reply = await call(CREATE_EVENT, { kind: 'photo', data: photoOf(400 * 1024) });

    expect(reply.error).toMatch(/full/i);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('tells the player something a player can read', async () => {
    // §2.9: the message reaches a toast, so no `[Repository]` prefix and no table name.
    dbMock.single.mockResolvedValue({ bytes: 64 * MB });

    const reply = await call(CREATE_EVENT, { kind: 'photo', data: photoOf(400 * 1024) });

    expect(reply.error).not.toContain('[Repository]');
    expect(reply.error).not.toContain('gphone_media');
  });

  it('honours the convar rather than the compiled-in default', async () => {
    withConvars({ gphone_media_quota_mb: 1 });
    dbMock.single.mockResolvedValue({ bytes: 900 * 1024 });

    const reply = await call(CREATE_EVENT, { kind: 'photo', data: photoOf(200 * 1024) });

    expect(reply.error).toMatch(/full/i);
  });

  it('is off at zero, and off rather than closed for a value it cannot parse', async () => {
    // `GetConvarInt` answers 0 for a non-numeric convar, so this is also the typo case:
    // the failure direction is "no quota", never "no photos on this server".
    withConvars({ gphone_media_quota_mb: 0 });
    dbMock.single.mockResolvedValue({ bytes: 500 * MB });

    const reply = await call(CREATE_EVENT, { kind: 'photo', data: photoOf(400 * 1024) });

    expect(reply.error).toBeUndefined();
    // Nothing is even measured when there is no ceiling to measure against.
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('composes with the per-row cap rather than replacing it', async () => {
    // MICA-116's 4MiB bound still applies to a single write, quota or no quota.
    withConvars({ gphone_media_quota_mb: 0 });

    const reply = await call(CREATE_EVENT, { kind: 'photo', data: photoOf(5 * MB) });

    expect(reply.error).toMatch(/too large/i);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

describe('a proximity drop respects the recipient’s quota', () => {
  it('skips a bystander who has no room, and reports the copies actually written', async () => {
    proximity.nearby = [
      { source: 9, citizenid: 'CID_B' },
      { source: 11, citizenid: 'CID_C' }
    ];
    dbMock.single.mockResolvedValue(OWNED_ROW);
    dbMock.query.mockResolvedValue([{ citizenid: 'CID_B', bytes: 64 * MB }]);

    const reply = await call(DROP_EVENT, { mediaId: 42 });

    expect(reply).toEqual({ count: 1 });
    const insertParams = dbMock.insert.mock.calls[0][1] as unknown[];
    expect(insertParams[0]).toBe('CID_C');
  });

  it('measures every recipient in one grouped query, not one per bystander', async () => {
    proximity.nearby = [
      { source: 9, citizenid: 'CID_B' },
      { source: 11, citizenid: 'CID_C' }
    ];
    dbMock.single.mockResolvedValue(OWNED_ROW);

    await call(DROP_EVENT, { mediaId: 42 });

    const grouped = queries().filter((q) => q.includes('GROUP BY citizenid'));
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toContain('citizenid IN (?, ?)');
  });

  it('writes nothing when every nearby player is already full', async () => {
    proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];
    dbMock.single.mockResolvedValue(OWNED_ROW);
    dbMock.query.mockResolvedValue([{ citizenid: 'CID_B', bytes: 64 * MB }]);

    const reply = await call(DROP_EVENT, { mediaId: 42 });

    expect(reply).toEqual({ count: 0 });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

describe('the retention prune', () => {
  it('does nothing at all while the convar is unset', async () => {
    expect(await pruneExpiredMedia()).toBe(0);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('hard-deletes rows older than the window, bounding the cutoff as a parameter', async () => {
    withConvars({ gphone_media_retention: 30 });
    dbMock.query.mockResolvedValue({ affectedRows: 7 });

    expect(await pruneExpiredMedia()).toBe(7);

    expect(lastQuery()).toBe('DELETE FROM gphone_media WHERE created_at < ?');
    const [cutoff] = dbMock.query.mock.calls.at(-1)![1] as string[];
    const days = (Date.now() - Date.parse(cutoff)) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it('covers every status, so the window an owner is told about has no exceptions', async () => {
    withConvars({ gphone_media_retention: 30 });
    dbMock.query.mockResolvedValue({ affectedRows: 0 });

    await pruneExpiredMedia();

    expect(lastQuery()).not.toContain('status');
  });

  it('reports zero rather than NaN when the driver answers something else', async () => {
    withConvars({ gphone_media_retention: 30 });
    dbMock.query.mockResolvedValue(undefined);

    expect(await pruneExpiredMedia()).toBe(0);
  });
});

describe('the orphan sweep — cleanup after a character is deleted', () => {
  it('refuses to run when players is empty, rather than treating every row as an orphan', async () => {
    dbMock.single.mockResolvedValue({ total: 0 });

    expect(await pruneOrphanedMedia()).toBe(0);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('refuses to run when players cannot be read at all', async () => {
    dbMock.single.mockResolvedValue(undefined);

    expect(await pruneOrphanedMedia()).toBe(0);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('deletes only rows whose owner is gone, once players answers', async () => {
    dbMock.single.mockResolvedValue({ total: 120 });
    dbMock.query.mockResolvedValue({ affectedRows: 3 });

    expect(await pruneOrphanedMedia()).toBe(3);

    const sql = lastQuery();
    expect(sql).toContain('DELETE FROM gphone_media WHERE NOT EXISTS');
    expect(sql).toContain('p.citizenid = gphone_media.citizenid');
    // NOT IN against a subquery holding a NULL is unknown for every row and deletes none.
    expect(sql).not.toContain('NOT IN');
  });
});

describe('purging one character', () => {
  it('deletes that citizenid’s rows, bound as a parameter', async () => {
    dbMock.query.mockResolvedValue({ affectedRows: 12 });

    expect(await purgeMediaForCitizen('CID_Z')).toBe(12);
    expect(lastQuery()).toBe('DELETE FROM gphone_media WHERE citizenid = ?');
    expect(dbMock.query.mock.calls.at(-1)![1]).toEqual(['CID_Z']);
  });

  it('does nothing for an empty or non-string citizenid', async () => {
    expect(await purgeMediaForCitizen('   ')).toBe(0);
    expect(await purgeMediaForCitizen(undefined as unknown as string)).toBe(0);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('is a local handler, never a net event a modified client could reach', () => {
    // §2.9: onNet would hand any player a one-argument delete of anyone else's gallery.
    expect(localHandlers.has(CHARACTER_DELETED_EVENT)).toBe(true);
    expect(handlers.has(CHARACTER_DELETED_EVENT)).toBe(false);
  });

  it('purges when told a character is gone', async () => {
    dbMock.query.mockResolvedValue({ affectedRows: 4 });

    localHandlers.get(CHARACTER_DELETED_EVENT)!('CID_Z');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lastQuery()).toBe('DELETE FROM gphone_media WHERE citizenid = ?');
    expect(dbMock.query.mock.calls.at(-1)![1]).toEqual(['CID_Z']);
  });

  it('ignores a payload that does not name a character', async () => {
    localHandlers.get(CHARACTER_DELETED_EVENT)!({ citizenid: 'CID_Z' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dbMock.query).not.toHaveBeenCalled();
  });
});

describe('runMediaMaintenance', () => {
  it('sweeps orphans even when retention is off', async () => {
    dbMock.single.mockResolvedValue({ total: 5 });
    dbMock.query.mockResolvedValue({ affectedRows: 2 });

    expect(await runMediaMaintenance()).toEqual({ expired: 0, orphaned: 2 });
  });

  it('still runs retention when the orphan sweep throws', async () => {
    withConvars({ gphone_media_retention: 10 });
    dbMock.single.mockRejectedValue(new Error('no players table'));
    dbMock.query.mockResolvedValue({ affectedRows: 6 });

    expect(await runMediaMaintenance()).toEqual({ expired: 6, orphaned: 0 });
  });

  it('never rejects, so start-up cannot be taken down by maintenance', async () => {
    withConvars({ gphone_media_retention: 10 });
    dbMock.single.mockRejectedValue(new Error('nope'));
    dbMock.query.mockRejectedValue(new Error('nope'));

    await expect(runMediaMaintenance()).resolves.toEqual({ expired: 0, orphaned: 0 });
  });
});

describe('gphonemedia prune', () => {
  const notifies = () =>
    (globalThis.emitNet as any).mock.calls.filter(
      (c: any[]) => c[0] === 'gphone:client:shell:notify'
    );

  it('refuses a player with no admin ace, before mentioning the subcommand exists', async () => {
    await runMediaPruneCommand(7);

    expect(notifies()[0]?.[2]).toMatchObject({ type: 'error' });
    expect(notifies()[0]?.[2].message).toMatch(/permission/i);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('refuses an in-game admin, because it is the one command here that deletes', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;

    await runMediaPruneCommand(7);

    expect(notifies()[0]?.[2].message).toMatch(/console/i);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('runs for the console', async () => {
    dbMock.single.mockResolvedValue({ total: 5 });
    dbMock.query.mockResolvedValue({ affectedRows: 1 });

    await runMediaPruneCommand(0);

    expect(lastQuery()).toContain('DELETE FROM gphone_media WHERE NOT EXISTS');
  });
});
