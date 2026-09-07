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

import { notes } from '../services/Notes';
import { __resetRateLimits } from '../lib/rateLimit';
import { TEST_PHONE_ID } from './phoneStub';

const call = async (action: string, data: unknown) => {
  const handler = handlers.get(`mica:server:notes:${action}`);
  if (!handler) throw new Error(`no handler for notes:${action}`);
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  dbMock.query.mockResolvedValue([]);
  dbMock.update.mockResolvedValue(true);
});

/**
 * MICA-75. Notes had no custom actions at all before this — the whole file was a
 * generic-CRUD declaration — so `restore` is the first thing here worth a dedicated test
 * file for. See `Repository.test.ts` for the mechanics `restore` itself is built on.
 */
describe('notes:restore (MICA-75)', () => {
  it('restores a deleted note within the window, scoped to the caller citizenid', async () => {
    const reply = await call('restore', { id: 5 });

    expect(reply).toEqual({ ok: true });
    const [sql, params] = dbMock.update.mock.calls[0];
    expect(String(sql)).toContain('UPDATE `mica_notes`');
    expect(params).toEqual([5, 'CIT_A', TEST_PHONE_ID, 30]);
  });

  it('reports false once the window has passed, rather than throwing', async () => {
    dbMock.update.mockResolvedValue(false);

    const reply = await call('restore', { id: 5 });

    expect(reply).toEqual({ ok: false });
  });

  it('refuses a payload naming a citizenid, rather than quietly ignoring it', async () => {
    const reply = await call('restore', { id: 5, citizenid: 'CIT_VICTIM' });

    // The predicate was always the caller's own citizenid, and still is. What changed is
    // that a payload asking for somebody else's is refused instead of ignored — the request
    // does not half-succeed with the hostile key dropped out of it.
    expect(reply).toMatchObject({ error: expect.stringContaining('citizenid') });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('rejects a missing id before touching the database', async () => {
    const reply = await call('restore', {});

    expect(reply).toMatchObject({ error: expect.any(String) });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('leaves the generic CRUD actions registered alongside it', () => {
    expect(handlers.has('mica:server:notes:restore')).toBe(true);
    expect(handlers.has('mica:server:notes:get')).toBe(true);
    expect(handlers.has('mica:server:notes:create')).toBe(true);
    expect(handlers.has('mica:server:notes:update')).toBe(true);
    expect(handlers.has('mica:server:notes:delete')).toBe(true);
    expect(notes.resolved.id).toBe('notes');
  });
});

/**
 * MICA-75-wiring: the "Recently Deleted" list itself. `status` is never
 * client-filterable, so this reads `Repository.findDeleted` through a named action rather
 * than the generic `get`. Notes is `core: false`, so the web side reaches this through
 * `useService('notes').call('getDeleted', {})` rather than a `shared/routes.ts` row — the
 * server side does not care either way.
 */
describe('notes:getDeleted (MICA-75-wiring)', () => {
  it('reads only the caller’s own deleted notes, bounded to the restore window', async () => {
    dbMock.query.mockResolvedValue([{ id: 5, citizenid: 'CIT_A', status: 'deleted' }]);

    const reply = await call('getDeleted', {});

    expect(reply).toEqual([{ id: 5, citizenid: 'CIT_A', status: 'deleted' }]);
    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('FROM `mica_notes`');
    expect(String(sql)).toContain("`status` = 'deleted'");
    expect(params).toEqual(['CIT_A', TEST_PHONE_ID, 30]);
  });

  it('refuses a payload claiming a citizenid — the list takes no payload at all', async () => {
    const reply = await call('getDeleted', { citizenid: 'CIT_VICTIM' });

    expect(reply).toMatchObject({ error: expect.stringContaining('payload') });
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('is registered alongside restore', () => {
    expect(handlers.has('mica:server:notes:getDeleted')).toBe(true);
  });
});
