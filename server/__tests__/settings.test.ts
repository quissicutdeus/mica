import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, handlers } = vi.hoisted(() => {
  // Inside `vi.hoisted` because ESM evaluates imports first: assigning `onNet` below the
  // imports would run after the service registered and capture nothing, which reads as
  // "no handler" rather than as a broken test.
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

const bridge = vi.hoisted(() => ({ current: 'ABC12345' }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.current, source: 3, setMeta: () => {} }),
    getCitizenId: () => bridge.current,
    registerUsableItem: () => {}
  }
}));

import { settings, getSettingsRepository } from '../services/Settings';

const CID = 'ABC12345';
const SRC = 3;

/**
 * Drive a registered handler the way `ServiceEndpoint` does.
 *
 * The reply crosses NUI as `emitNet`, and a throw inside the handler is turned into an
 * `{ error }` reply rather than propagating — so an assertion about a refusal reads that,
 * not `rejects.toThrow`.
 */
const call = async (action: string, data: unknown, citizenid = CID) => {
  const handler = handlers.get(`gphone:server:settings:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);
  bridge.current = citizenid;
  (globalThis as any).source = SRC;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls[0]?.[3];
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
});

describe('settings service', () => {
  it('declares the unique key that makes the upsert safe', () => {
    // Not decoration. Without it two writes in the same tick — which is what dragging a
    // slider produces — leave two rows for one preference, and the read picks whichever
    // the engine returns first.
    const index = (settings.resolved.indexes ?? []).find(
      (i: any) => i.name === 'citizenid_app_key'
    ) as any;
    expect(index).toBeDefined();
    expect(index.unique).toBe(true);
    expect(index.columns).toEqual(['citizenid', 'app', 'setting_key']);
  });

  it('registers no generic CRUD action', () => {
    // The client addresses a row by (app, setting_key) and never by id, so a generic
    // update or delete has nothing to act on and `get` would answer a page when the phone
    // needs the whole set.
    for (const action of ['get', 'create', 'update', 'delete']) {
      expect(handlers.has(`gphone:server:settings:${action}`), action).toBe(false);
    }
  });

  it('registers exactly the four named actions', () => {
    for (const action of ['getAll', 'set', 'remove', 'clearApp']) {
      expect(handlers.has(`gphone:server:settings:${action}`), action).toBe(true);
    }
  });

  describe('repository', () => {
    const repo = () => getSettingsRepository()!;

    it('upserts in one statement rather than find-then-insert', async () => {
      await repo().put(CID, 'settings', 'theme', '{"mode":"dark"}');

      expect(dbMock.query).toHaveBeenCalledTimes(1);
      const [sql, params] = dbMock.query.mock.calls[0];
      expect(sql).toMatch(/ON DUPLICATE KEY UPDATE/i);
      expect(params).toEqual([CID, 'settings', 'theme', '{"mode":"dark"}']);
    });

    it('scopes every read to the caller, not to a payload', async () => {
      await repo().findAllForPlayer(CID);

      const [sql, params] = dbMock.query.mock.calls[0];
      expect(sql).toMatch(/WHERE citizenid = \?/);
      expect(params).toEqual([CID]);
    });

    it('scopes a delete by citizenid as well as key', async () => {
      // A row id alone is never authorization (§2.9) — and here there is no id at all, so
      // the predicate is the entire protection.
      await repo().remove(CID, 'blabber', 'activeAccountId');

      const [sql, params] = dbMock.query.mock.calls[0];
      expect(sql).toMatch(/citizenid = \? AND app = \? AND setting_key = \?/);
      expect(params).toEqual([CID, 'blabber', 'activeAccountId']);
    });

    it('clears a namespace without reaching another player', async () => {
      await repo().clearApp(CID, 'snake');

      const [sql, params] = dbMock.query.mock.calls[0];
      expect(sql).toMatch(/citizenid = \? AND app = \?/);
      expect(params).toEqual([CID, 'snake']);
    });

    it('reads one setting for many players in one query', async () => {
      // Built for server/lib/proximity.ts's Bluetooth visibility filter — one query per
      // candidate would mean one query per nearby player on every share.
      dbMock.query.mockResolvedValueOnce([
        { citizenid: 'CID_B', setting_value: 'false' },
        { citizenid: 'CID_C', setting_value: 'true' }
      ]);

      const values = await repo().getValuesFor(
        ['CID_B', 'CID_C', 'CID_D'],
        'settings',
        'bluetooth_enabled'
      );

      expect(dbMock.query).toHaveBeenCalledTimes(1);
      const [sql, params] = dbMock.query.mock.calls[0];
      expect(sql).toMatch(/citizenid IN \(\?,\?,\?\)/);
      expect(params).toEqual(['settings', 'bluetooth_enabled', 'CID_B', 'CID_C', 'CID_D']);
      // CID_D never had a row and is simply absent, not defaulted here — the caller
      // decides what a missing preference means.
      expect(values).toEqual(
        new Map([
          ['CID_B', 'false'],
          ['CID_C', 'true']
        ])
      );
    });

    it('makes no query for an empty citizenid list', async () => {
      const values = await repo().getValuesFor([], 'settings', 'bluetooth_enabled');

      expect(dbMock.query).not.toHaveBeenCalled();
      expect(values.size).toBe(0);
    });
  });

  describe('payload validation', () => {
    it('refuses a value too long for its column instead of letting MySQL truncate it', async () => {
      // Non-strict MySQL truncates silently: row written, success reported, preference
      // quietly wrong.
      const reply = await call('set', {
        app: 'settings',
        key: 'theme',
        value: 'x'.repeat(9000)
      });

      expect(reply?.error).toMatch(/too large/i);
      expect(dbMock.query).not.toHaveBeenCalled();
    });

    it('refuses an over-length namespace or key', async () => {
      expect(
        (await call('set', { app: 'x'.repeat(40), key: 'k', value: '1' }))?.error
      ).toBeTruthy();
      expect(
        (await call('set', { app: 'a', key: 'k'.repeat(80), value: '1' }))?.error
      ).toBeTruthy();
      expect(dbMock.query).not.toHaveBeenCalled();
    });

    it('refuses an empty namespace or key', async () => {
      expect((await call('set', { app: '', key: 'k', value: '1' }))?.error).toBeTruthy();
      expect((await call('set', { app: 'a', key: '   ', value: '1' }))?.error).toBeTruthy();
    });

    it('never names the table or the class in a message a player can trigger', async () => {
      // These are the one family of throws here a player reaches, so they must not read
      // like a stack trace (§2.9).
      const reply = await call('set', { app: 'settings', key: 'theme', value: 'x'.repeat(9000) });
      expect(reply?.error).not.toMatch(/gphone_settings|Repository/);
    });

    it('stores a non-string value as JSON so the column always parses', async () => {
      await call('set', { app: 'settings', key: 'displaySize', value: 50 });

      const [, params] = dbMock.query.mock.calls[0];
      expect(params[3]).toBe('50');
    });

    it('writes under the caller citizenid, never one from the payload', async () => {
      // The obvious attack on a table keyed by citizenid: name somebody else's and write
      // their theme. The session decides, and the payload's copy is ignored.
      await call('set', {
        app: 'settings',
        key: 'theme',
        value: '"dark"',
        citizenid: 'VICTIM99'
      });

      const [, params] = dbMock.query.mock.calls[0];
      expect(params[0]).toBe(CID);
      expect(params).not.toContain('VICTIM99');
    });
  });
});
