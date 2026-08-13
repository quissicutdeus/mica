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
    getPlayer: () => ({ citizenid: 'CIT_A', source: 5, setMeta: () => {} }),
    getSourceByCitizenId: () => null,
    getPlayerByPhone: () => null
  }
}));

const directory = vi.hoisted(() => ({ byPhone: new Map<string, { citizenid: string }>() }));
vi.mock('../lib/PlayerDirectory', () => ({
  resolveByPhone: async (phone: string) => directory.byPhone.get(phone) ?? null
}));

import { conversations } from '../services/Conversations';

const call = async (action: string, data: unknown) => {
  const handler = handlers.get(`gphone:server:conversations:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

beforeEach(() => {
  vi.clearAllMocks();
  directory.byPhone.clear();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(101);
  dbMock.update.mockResolvedValue(true);
  dbMock.single.mockResolvedValue(null);
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
});

/**
 * A row id a caller happens to know is never proof they know that person. `create` used to
 * trust a raw `participant` string, and a raw `participants` array, as citizenids straight
 * from the client — both are now only reachable by resolving a phone number first, the same
 * gate the 1-on-1 `phone` path already enforced.
 */
describe('conversations:create — citizenids only via phone resolution', () => {
  it('does not add a raw citizenid string sent as `participant`', async () => {
    await call('create', { participant: 'SOME_OTHER_CITIZENID' });

    const addedCitizenids = dbMock.insert.mock.calls
      .filter(([sql]) => typeof sql === 'string' && sql.includes('gphone_messages_participants'))
      .map(([, params]) => (params as unknown[])[1]);

    expect(addedCitizenids).not.toContain('SOME_OTHER_CITIZENID');
    // Only the caller themselves was added.
    expect(addedCitizenids).toEqual(['CIT_A']);
  });

  it('resolves group `participants` entries as phone numbers, not citizenids', async () => {
    directory.byPhone.set('555-0100', { citizenid: 'CIT_B' });

    await call('create', { is_group: true, participants: ['555-0100', '555-9999', 'CIT_C'] });

    const addedCitizenids = dbMock.insert.mock.calls
      .filter(([sql]) => typeof sql === 'string' && sql.includes('gphone_messages_participants'))
      .map(([, params]) => (params as unknown[])[1]);

    // 555-0100 resolves to CIT_B and is added; 555-9999 resolves to nobody and is skipped;
    // the bare string 'CIT_C' is never treated as a citizenid at all.
    expect(addedCitizenids).toEqual(expect.arrayContaining(['CIT_A', 'CIT_B']));
    expect(addedCitizenids).not.toContain('CIT_C');
    expect(addedCitizenids).toHaveLength(2);
  });

  it('still resolves the 1-on-1 target through `phone`, unaffected', async () => {
    directory.byPhone.set('555-0100', { citizenid: 'CIT_B' });

    await call('create', { phone: '555-0100' });

    const addedCitizenids = dbMock.insert.mock.calls
      .filter(([sql]) => typeof sql === 'string' && sql.includes('gphone_messages_participants'))
      .map(([, params]) => (params as unknown[])[1]);

    expect(addedCitizenids).toEqual(expect.arrayContaining(['CIT_A', 'CIT_B']));
  });
});

describe('the declaration', () => {
  it('still disables the generic create in favor of this custom handler', () => {
    expect(handlers.has('gphone:server:conversations:create')).toBe(true);
    expect(conversations.resolved.columns).not.toContain('participant');
  });
});
