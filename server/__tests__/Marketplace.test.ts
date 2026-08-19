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

const bridge = vi.hoisted(() => ({ current: 'CIT_A' }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.current, source: 5, setMeta: () => {} }),
    getCitizenId: () => bridge.current,
    registerUsableItem: () => {}
  }
}));

const playerDirectoryMock = vi.hoisted(() => ({
  resolve: vi.fn().mockResolvedValue({ citizenid: 'CIT_A', displayName: null, phone: '555-0100' })
}));
vi.mock('../lib/PlayerDirectory', () => playerDirectoryMock);

import { marketplace } from '../services/Marketplace';
import type { MarketplaceRepository } from '../repositories/MarketplaceRepository';

// Referencing `.repo` (not just importing the binding) keeps this side-effecting import
// alive under esbuild's tree-shaking — an unreferenced named import can otherwise be
// elided, which drops the `registerEvent` calls this whole file depends on. Same reason
// `blabber.test.ts` does this.
const repo = marketplace.repo as MarketplaceRepository;
void repo;

const call = async (action: string, data: unknown, citizenid = 'CIT_A') => {
  const handler = handlers.get(`gphone:server:marketplace:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);
  bridge.current = citizenid;
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls[0]?.[3];
};

describe('Marketplace service', () => {
  beforeEach(() => {
    dbMock.query.mockReset();
    dbMock.insert.mockReset();
    dbMock.update.mockReset();
    dbMock.single.mockReset();
    dbMock.scalar.mockReset();
  });

  describe('create', () => {
    it('rejects a missing title, price, or description', async () => {
      expect((await call('create', { price: 100, description: 'x' })).error).toBeTruthy();
      expect((await call('create', { title: 'x', description: 'x' })).error).toBeTruthy();
      expect((await call('create', { title: 'x', price: 100 })).error).toBeTruthy();
    });

    it('rejects a negative price', async () => {
      const reply = await call('create', { title: 'Bike', price: -1, description: 'nice bike' });
      expect(reply.error).toMatch(/valid price/);
    });

    it('drops attachments the caller does not own, and caps at 4', async () => {
      // resolveOwnedAttachments calls media.repo.findById(id, citizenid) -> Database.single,
      // once per attachment in payload order. ids 1-5 are "owned", 999 is not.
      dbMock.single.mockImplementation(async (_sql: string, params: unknown[]) => {
        const id = params[0];
        return typeof id === 'number' && id <= 5 ? { id } : null;
      });
      dbMock.insert.mockResolvedValue(1);
      dbMock.query.mockResolvedValue([]);

      const reply = await call('create', {
        title: 'Couch',
        price: 200,
        description: 'barely used',
        attachments: [
          { photo_id: 1 },
          { photo_id: 2 },
          { photo_id: 3 },
          { photo_id: 4 },
          { photo_id: 5 }, // 5th owned attachment — dropped by the 4-cap
          { photo_id: 999 } // not owned — dropped regardless
        ]
      });

      expect(reply.error).toBeUndefined();
      // 1 insert for the listing row + 4 for the capped attachments.
      expect(dbMock.insert).toHaveBeenCalledTimes(5);
    });

    it('inserts owned attachment rows into the child table, scoped to the caller', async () => {
      dbMock.single.mockResolvedValue({ id: 1 });
      dbMock.insert.mockResolvedValueOnce(42); // the listing row
      dbMock.insert.mockResolvedValueOnce(1); // the attachment row

      await call('create', {
        title: 'Radio',
        price: 50,
        description: 'works fine',
        attachments: [{ photo_id: 1 }]
      });

      const attachmentInsert = dbMock.insert.mock.calls.find(([sql]) =>
        String(sql).includes('gphone_marketplace_attachments')
      );
      expect(attachmentInsert?.[1]).toEqual([42, 'CIT_A', 1]);
    });
  });

  describe('view', () => {
    it('returns isOwn true when the caller owns the listing', async () => {
      dbMock.single
        .mockResolvedValueOnce({ id: 1, title: 'Bike', price: 10 }) // public row
        .mockResolvedValueOnce({ citizenid: 'CIT_A' }); // owner lookup
      dbMock.query.mockResolvedValue([]);

      const reply = await call('view', { id: 1 }, 'CIT_A');
      expect(reply.error).toBeUndefined();
      expect(reply.isOwn).toBe(true);
    });

    it('returns isOwn false when the caller does not own the listing', async () => {
      dbMock.single
        .mockResolvedValueOnce({ id: 1, title: 'Bike', price: 10 })
        .mockResolvedValueOnce({ citizenid: 'CIT_B' });
      dbMock.query.mockResolvedValue([]);

      const reply = await call('view', { id: 1 }, 'CIT_A');
      expect(reply.isOwn).toBe(false);
    });

    it('never returns citizenid on the public row', async () => {
      dbMock.single
        .mockResolvedValueOnce({ id: 1, title: 'Bike', price: 10 })
        .mockResolvedValueOnce({ citizenid: 'CIT_A' });
      dbMock.query.mockResolvedValue([]);

      const reply = await call('view', { id: 1 }, 'CIT_A');
      expect(reply.citizenid).toBeUndefined();
    });
  });

  describe('feed / search', () => {
    it('feed excludes sold/removed/moderated listings and never selects citizenid', async () => {
      dbMock.query.mockResolvedValue([]);
      await call('feed', {});
      const [sql] = dbMock.query.mock.calls[0];
      expect(String(sql)).toContain("status` = 'active'");
      expect(String(sql)).not.toMatch(/citizenid/i);
    });

    it('search matches title or description via LIKE', async () => {
      dbMock.query.mockResolvedValue([]);
      await call('search', { q: 'bike' });
      const [sql, params] = dbMock.query.mock.calls[0];
      expect(String(sql)).toMatch(/title.*LIKE.*OR.*description.*LIKE/is);
      expect(params).toEqual(expect.arrayContaining(['%bike%', '%bike%']));
    });
  });

  describe('mine', () => {
    it('returns every status for the caller, not just active', async () => {
      dbMock.query.mockResolvedValue([]);
      await call('mine', {}, 'CIT_A');
      const [sql, params] = dbMock.query.mock.calls[0];
      expect(String(sql)).not.toContain("status` = 'active'");
      expect(params).toContain('CIT_A');
    });
  });

  describe('markSold / remove', () => {
    it('markSold refuses a listing the caller does not own', async () => {
      dbMock.single.mockResolvedValue({ id: 1, citizenid: 'CIT_B', status: 'active' });
      const reply = await call('markSold', { id: 1 }, 'CIT_A');
      expect(reply.error).toMatch(/not yours/);
      expect(dbMock.update).not.toHaveBeenCalled();
    });

    it('markSold refuses a listing that is not active', async () => {
      dbMock.single.mockResolvedValue({ id: 1, citizenid: 'CIT_A', status: 'sold' });
      const reply = await call('markSold', { id: 1 }, 'CIT_A');
      expect(reply.error).toMatch(/active listing/);
      expect(dbMock.update).not.toHaveBeenCalled();
    });

    it('markSold transitions an owned active listing to sold', async () => {
      dbMock.single.mockResolvedValue({ id: 1, citizenid: 'CIT_A', status: 'active' });
      dbMock.update.mockResolvedValue(true);
      const reply = await call('markSold', { id: 1 }, 'CIT_A');
      expect(reply.error).toBeUndefined();
      expect(dbMock.update).toHaveBeenCalledWith(expect.stringMatching(/UPDATE.*'sold'/is), [1]);
    });

    it('remove refuses a listing the caller does not own', async () => {
      dbMock.single.mockResolvedValue({ id: 1, citizenid: 'CIT_B', status: 'active' });
      const reply = await call('remove', { id: 1 }, 'CIT_A');
      expect(reply.error).toMatch(/not yours/);
      expect(dbMock.update).not.toHaveBeenCalled();
    });

    it('remove transitions an owned active listing to removed', async () => {
      dbMock.single.mockResolvedValue({ id: 1, citizenid: 'CIT_A', status: 'active' });
      dbMock.update.mockResolvedValue(true);
      const reply = await call('remove', { id: 1 }, 'CIT_A');
      expect(reply.error).toBeUndefined();
      expect(dbMock.update).toHaveBeenCalledWith(expect.stringMatching(/UPDATE.*'removed'/is), [1]);
    });
  });
});
