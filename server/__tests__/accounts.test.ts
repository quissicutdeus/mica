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

import { accounts, ownedAccount } from '../services/Accounts';

const SRC = 5;

const call = async (action: string, data: unknown, citizenid = 'CIT_A') => {
  const handler = handlers.get(`gphone:server:accounts:${action}`);
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
  dbMock.insert.mockResolvedValue(7);
  dbMock.update.mockResolvedValue(true);
  dbMock.single.mockResolvedValue(null);
  dbMock.scalar.mockResolvedValue(0);
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
});

/**
 * Social identities, shared across social apps.
 *
 * The two things worth pinning: a public read must never carry `citizenid`, because with
 * several accounts per player it correlates two deliberately-separate identities back to one
 * person; and nothing may act as an account it does not own, because the `account_id` on a
 * post is a client-chosen value and §2.9 says a payload is not proof of intent.
 */

describe('the declaration', () => {
  it('keeps citizenid out of a public read', () => {
    expect(accounts.resolved.publicColumns).not.toContain('citizenid');
    expect(accounts.resolved.publicColumns).toContain('handle');
  });

  it('makes app and handle unwritable through the generic path', () => {
    // Renaming a handle would silently break every mention of it, and moving an account to
    // another app would let a player squat a namespace they never claimed in.
    expect(accounts.resolved.clientWritable).not.toContain('handle');
    expect(accounts.resolved.clientWritable).not.toContain('app');
    // The presentation fields stay editable, which is what makes the generic update useful.
    expect(accounts.resolved.clientWritable).toEqual(
      expect.arrayContaining(['display_name', 'avatar', 'bio'])
    );
  });

  it('makes handles unique per app rather than globally', () => {
    // `@ada` on Blabber and `@ada` on Instagram are different identities, and may well be
    // different people.
    const unique = accounts.resolved.indexes.find((i) => i.name === 'app_handle');
    expect(unique).toMatchObject({ columns: ['app', 'handle'], unique: true });
  });

  it('declares paging, which a public read cannot go without', () => {
    expect(accounts.resolved.paging).not.toBeNull();
  });
});

describe('claiming a handle', () => {
  it('creates an account for the caller', async () => {
    const reply = await call('create', { app: 'blabber', handle: 'ada', display_name: 'Ada' });

    expect(reply).toMatchObject({ id: 7, app: 'blabber', handle: 'ada', citizenid: 'CIT_A' });
  });

  it('lowercases the handle so @Ada and @ada cannot both exist', async () => {
    await call('create', { app: 'blabber', handle: 'AdA' });

    const inserted = dbMock.insert.mock.calls[0][1] as unknown[];
    expect(inserted).toContain('ada');
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(33)],
    ['spaces', 'ada lovelace'],
    ['punctuation', 'ada!'],
    ['a leading at-sign', '@ada']
  ])('refuses a handle with %s', async (_label, handle) => {
    const reply = await call('create', { app: 'blabber', handle });

    expect(reply.error).toMatch(/3–32 characters/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a handle already claimed in that app', async () => {
    dbMock.single.mockResolvedValueOnce({ id: 1 });

    const reply = await call('create', { app: 'blabber', handle: 'ada' });

    expect(reply.error).toBe('@ada is taken.');
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('translates a lost race at the unique index into something readable', async () => {
    // Two players claiming in the same instant both pass the pre-check and one loses at the
    // index. That is the correct outcome; the raw driver error is not what a player should read.
    dbMock.insert.mockRejectedValueOnce(new Error("Duplicate entry 'blabber-ada' for key ..."));

    const reply = await call('create', { app: 'blabber', handle: 'ada' });

    expect(reply.error).toBe('@ada is taken.');
  });

  it('caps how many accounts a player may hold in one app', async () => {
    // The handle namespace is public and finite: uncapped, one player claims every good name.
    dbMock.scalar.mockResolvedValueOnce(3);

    const reply = await call('create', { app: 'blabber', handle: 'alt' });

    expect(reply.error).toMatch(/already hold 3 accounts/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('honours a convar raising the cap', async () => {
    (globalThis as any).GetConvar = (name: string, f: string) =>
      name === 'gphone_max_accounts_per_app' ? '5' : f;
    dbMock.scalar.mockResolvedValueOnce(3);

    const reply = await call('create', { app: 'blabber', handle: 'alt' });

    expect(reply).toMatchObject({ handle: 'alt' });
  });

  it('requires an app id', async () => {
    const reply = await call('create', { handle: 'ada' });

    expect(reply.error).toMatch(/app id is required/);
  });
});

describe('listing my own accounts', () => {
  it('scopes to the caller server-side rather than trusting a filter', async () => {
    // Deliberately not a filter on the public `get`: making citizenid client-filterable would
    // let anyone list anyone's accounts, which is exactly the correlation this table avoids.
    await call('mine', { app: 'blabber' }, 'CIT_B');

    const params = dbMock.query.mock.calls[0][1] as unknown[];
    expect(params).toEqual(['CIT_B', 'blabber']);
  });

  it('requires an app id', async () => {
    const reply = await call('mine', {});

    expect(reply.error).toMatch(/app id is required/);
  });

  it('reports the per-app cap, so the UI does not have to guess a convar', async () => {
    dbMock.query.mockResolvedValueOnce([{ id: 1, handle: 'ada' }]);

    const reply = await call('mine', { app: 'blabber' });

    expect(reply).toMatchObject({ rows: [{ handle: 'ada' }], limit: 3 });
  });

  it('reports a raised cap from the convar', async () => {
    (globalThis as any).GetConvar = (name: string, f: string) =>
      name === 'gphone_max_accounts_per_app' ? '5' : f;
    dbMock.query.mockResolvedValueOnce([]);

    const reply = await call('mine', { app: 'blabber' });

    expect(reply).toMatchObject({ rows: [], limit: 5 });
  });
});

describe('ownedAccount', () => {
  it('returns the account when it belongs to the caller in that app', async () => {
    dbMock.single.mockResolvedValueOnce({ id: 3, handle: 'ada', app: 'blabber' });

    await expect(ownedAccount(3, 'CIT_A', 'blabber')).resolves.toMatchObject({ handle: 'ada' });

    const params = dbMock.single.mock.calls[0][1] as unknown[];
    expect(params).toEqual([3, 'CIT_A', 'blabber']);
  });

  it('returns null for an account belonging to somebody else', async () => {
    // The whole point: `account_id` on a post is chosen by the client, and nothing about the
    // payload proves the account is theirs.
    dbMock.single.mockResolvedValueOnce(null);

    await expect(ownedAccount(3, 'CIT_OTHER', 'blabber')).resolves.toBeNull();
  });

  it.each([
    ['a non-numeric id', 'not-a-number'],
    ['zero', 0],
    ['a negative id', -1],
    ['undefined', undefined]
  ])('returns null for %s without querying', async (_label, id) => {
    await expect(ownedAccount(id, 'CIT_A', 'blabber')).resolves.toBeNull();
    expect(dbMock.single).not.toHaveBeenCalled();
  });
});
