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
    getPlayer: () => ({ citizenid: 'CIT_A', source: 5, setMeta: () => {} }),
    getSourceByCitizenId: () => null,
    getPlayerByPhone: () => null
  }
}));

const directory = vi.hoisted(() => ({
  byPhone: new Map<string, { citizenid: string }>(),
  /** Every number `create` actually looked up, in order — the cap is a bound on this too. */
  lookups: [] as string[]
}));
vi.mock('../lib/PlayerDirectory', () => ({
  resolveByPhone: async (phone: string) => {
    directory.lookups.push(phone);
    return directory.byPhone.get(phone) ?? null;
  }
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

/** Citizenids handed to a participants-table insert, in the order they were written. */
const participantsAdded = () =>
  dbMock.insert.mock.calls
    .filter(([sql]) => typeof sql === 'string' && sql.includes('gphone_messages_participants'))
    .map(([, params]) => (params as unknown[])[1]);

beforeEach(() => {
  vi.clearAllMocks();
  directory.byPhone.clear();
  directory.lookups.length = 0;
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

/**
 * MICA-153. `is_group` decided whether the Messages UI drew the member list, the group
 * heading and the per-message sender name, and `create` read it straight off the payload —
 * so a client could stand a third account inside a thread the victim was shown as a private
 * DM, with no surface anywhere in the app on which to find them.
 */
describe('conversations:create — is_group is derived, never taken from the payload', () => {
  it('refuses a payload claiming is_group: false over three people', async () => {
    directory.byPhone.set('555-0100', { citizenid: 'CIT_B' });
    directory.byPhone.set('555-0200', { citizenid: 'CIT_EAVESDROPPER' });

    const created = await call('create', {
      is_group: false,
      phone: '555-0100',
      participants: ['555-0200']
    });

    // Three people in the row means a group, whatever the payload said — which is what
    // makes the participants section render and the sender names appear.
    expect(created.is_group).toBe(true);
    expect(participantsAdded()).toEqual(
      expect.arrayContaining(['CIT_A', 'CIT_B', 'CIT_EAVESDROPPER'])
    );
  });

  it('will not look for a one-to-one to reuse once a third person is in the thread', async () => {
    directory.byPhone.set('555-0100', { citizenid: 'CIT_B' });
    directory.byPhone.set('555-0200', { citizenid: 'CIT_EAVESDROPPER' });

    await call('create', { is_group: false, phone: '555-0100', participants: ['555-0200'] });

    // `findOneToOne` filters on `c.is_group = 0`. It is not consulted here, and the row it
    // would have to match is written with the flag set — so a three-party thread can never
    // be handed back as the canonical pair for two of the people inside it.
    const askedForAPair = dbMock.query.mock.calls.some(
      ([sql]) => typeof sql === 'string' && sql.includes('c.is_group = 0')
    );
    expect(askedForAPair).toBe(false);
  });

  it('derives the flag downwards too — is_group: true over one other person is a pair', async () => {
    directory.byPhone.set('555-0100', { citizenid: 'CIT_B' });

    const created = await call('create', { is_group: true, phone: '555-0100' });

    expect(created.is_group).toBe(false);
    // Two people is a pair, so the reuse check runs and this thread is one-to-one.
    const askedForAPair = dbMock.query.mock.calls.some(
      ([sql]) => typeof sql === 'string' && sql.includes('c.is_group = 0')
    );
    expect(askedForAPair).toBe(true);
  });
});

/**
 * The other half of MICA-153: `participants` was a raw client array with no dedup and no
 * cap, so one number repeated 500 times wrote 500 live rows for one person and
 * `Messages.deliverToParticipants` then emitted 500 packets per message, permanently.
 */
describe('conversations:create — the participant list is deduplicated and bounded', () => {
  it('collapses a number repeated many times to one participant and one lookup', async () => {
    directory.byPhone.set('555-victim', { citizenid: 'CIT_VICTIM' });

    const created = await call('create', {
      participants: Array.from({ length: 500 }, () => '555-victim')
    });

    expect(participantsAdded()).toEqual(['CIT_A', 'CIT_VICTIM']);
    // Deduplicated before resolution, so the 500 entries cost one directory query.
    expect(directory.lookups).toEqual(['555-victim']);
    // One other person is a pair, not a group.
    expect(created.is_group).toBe(false);
  });

  it('collapses two spellings that resolve to the same person', async () => {
    directory.byPhone.set('555-0100', { citizenid: 'CIT_B' });
    directory.byPhone.set('5550100', { citizenid: 'CIT_B' });

    await call('create', { participants: ['555-0100', '5550100'] });

    // Both numbers are looked up — they are different strings — but the person behind them
    // is added once. Deduplicating the phone strings alone would not have caught this.
    expect(directory.lookups).toHaveLength(2);
    expect(participantsAdded()).toEqual(['CIT_A', 'CIT_B']);
  });

  it('refuses a request over the cap, with a player-readable message, before resolving any of it', async () => {
    const phones = Array.from({ length: 100 }, (_, i) => `555-${String(i).padStart(4, '0')}`);
    for (const [index, phone] of phones.entries()) {
      directory.byPhone.set(phone, { citizenid: `CIT_${index}` });
    }

    const result = await call('create', { participants: phones });

    expect(result).toEqual({ error: 'A conversation can hold at most 32 people.' });
    // Refused outright rather than silently truncated: nothing was written, and the cap
    // bounds the work, not just the result — an oversized list never buys 100 directory
    // queries or 32 wasted ones.
    expect(participantsAdded()).toHaveLength(0);
    expect(directory.lookups).toHaveLength(0);
  });

  it('allows a request that lands exactly on the cap', async () => {
    const phones = Array.from({ length: 31 }, (_, i) => `555-${String(i).padStart(4, '0')}`);
    for (const [index, phone] of phones.entries()) {
      directory.byPhone.set(phone, { citizenid: `CIT_${index}` });
    }

    await call('create', { participants: phones });

    // 31 requested plus the creator is exactly 32 — the cap, not one over it.
    expect(participantsAdded()).toHaveLength(32);
  });
});

/**
 * Where the uniqueness actually lives. A `UNIQUE (conversation_id, citizenid)` would break
 * rejoining — leaving stamps `left_at` and coming back inserts a second row — and MySQL has
 * no partial unique index for "unique among the live rows", so the invariant is enforced by
 * the statement that writes.
 */
/**
 * MICA-156. `create` calls `findOneToOne` and then `createConversation`, two round trips
 * apart, and two people opening a chat with each other at the same moment both miss and both
 * create. No attacker is required — this is the ordinary case, and the messages then split
 * across two threads with no way to merge them.
 *
 * MICA-153's `conversation_participant_unique` cannot reach it: two racing creates produce
 * two different `conversation_id` values, so the participant rows never collide.
 *
 * What lands here narrows the window rather than closing it. A conversation is only *a pair*
 * once its participant rows exist, which is after the insert, so there is nothing for a
 * `NOT EXISTS` guard on that insert to test. The reconciliation runs afterwards, when both
 * racers can see each other, and resolves a deterministic winner.
 */
describe('conversations:create — a thread lost to a race stands down', () => {
  /** `reconcilePairDuplicate` asks two scalar questions; answer them by their SQL. */
  const scalarAnswers = ({ canonical, messages }: { canonical: unknown; messages?: number }) => {
    dbMock.scalar.mockImplementation(async (sql: string) => {
      if (sql.includes('ORDER BY c.id ASC')) return canonical;
      if (sql.includes('COUNT(*) FROM gphone_messages')) return messages ?? 0;
      return null;
    });
  };

  const discarded = () =>
    dbMock.update.mock.calls
      .filter(([sql]) => typeof sql === 'string' && sql.includes('gphone_messages_conversations'))
      .map(([, params]) => params);

  beforeEach(() => {
    directory.byPhone.set('555-0100', { citizenid: 'CIT_B' });
    dbMock.insert.mockResolvedValue(202);
  });

  it('returns the older thread and discards its own when it lost', async () => {
    // Both racers resolve the same lowest id, so the one that is not it stands down. Without
    // that total order, two racers each seeing the other would each defer and both threads
    // would be thrown away.
    scalarAnswers({ canonical: 101 });

    const created = await call('create', { phone: '555-0100' });

    expect(created.id).toBe(101);
    expect(discarded()).toHaveLength(1);
  });

  it('keeps its own thread when it is the older one', async () => {
    scalarAnswers({ canonical: 202 });

    const created = await call('create', { phone: '555-0100' });

    expect(created.id).toBe(202);
    expect(discarded()).toHaveLength(0);
  });

  it('never discards a thread that already holds a message', async () => {
    // The reconciliation only ever runs against a thread this request just created, but a
    // message can land in it in between. Losing one to a tidy-up is a worse bug than the
    // duplicate it was cleaning up, so the count is a condition and not an assertion.
    scalarAnswers({ canonical: 101, messages: 1 });

    const created = await call('create', { phone: '555-0100' });

    expect(created.id).toBe(202);
    expect(discarded()).toHaveLength(0);
  });

  it('keeps its own thread when the pair cannot be read back at all', async () => {
    // A participant write that has not landed, or a failed query. Guessing here would throw
    // away a perfectly good thread on no evidence.
    scalarAnswers({ canonical: null });

    const created = await call('create', { phone: '555-0100' });

    expect(created.id).toBe(202);
    expect(discarded()).toHaveLength(0);
  });

  it('does not reconcile a group thread, which has no pair to be duplicate of', async () => {
    directory.byPhone.set('555-0200', { citizenid: 'CIT_C' });
    scalarAnswers({ canonical: 101 });

    const created = await call('create', { phone: '555-0100', participants: ['555-0200'] });

    expect(created.id).toBe(202);
    expect(discarded()).toHaveLength(0);
  });
});

describe('addParticipant — the live row is unique by construction', () => {
  const repo = conversations.repo as unknown as {
    addParticipant: (id: number, citizenid: string, role?: 'admin' | 'member') => Promise<boolean>;
  };

  it('guards the insert on there being no live row for that person', async () => {
    await repo.addParticipant(7, 'CIT_B');

    const [sql, params] = dbMock.insert.mock.calls.at(-1) as [string, unknown[]];
    const normalized = sql.replace(/\s+/g, ' ');

    expect(normalized).toContain('NOT EXISTS');
    // The guard is the liveness rule, not the pair: a row someone has left does not block
    // them coming back.
    expect(normalized).toContain('left_at IS NULL');
    expect(normalized).not.toContain('ON DUPLICATE KEY');
    // Conversation and citizenid are bound twice — once for the row, once for the guard.
    expect(params).toEqual([7, 'CIT_B', 'member', 7, 'CIT_B']);
  });

  it('reports that nothing was written when the guard matched an existing live row', async () => {
    // A conditional insert that inserted no row reports an insert id of 0.
    dbMock.insert.mockResolvedValueOnce(0);

    await expect(repo.addParticipant(7, 'CIT_B')).resolves.toBe(false);
  });

  it('reports a write when the row was actually inserted', async () => {
    dbMock.insert.mockResolvedValueOnce(42);

    await expect(repo.addParticipant(7, 'CIT_B')).resolves.toBe(true);
  });
});

describe('the declaration', () => {
  it('still disables the generic create in favor of this custom handler', () => {
    expect(handlers.has('gphone:server:conversations:create')).toBe(true);
    expect(conversations.resolved.columns).not.toContain('participant');
  });

  it('keeps is_group out of the client-writable set, so the generic update cannot set it', () => {
    expect(conversations.resolved.columns).toContain('is_group');
    expect(conversations.repo['clientWritable']).not.toContain('is_group');
  });

  it('keeps participant_a/participant_b/pair_key out of the client-writable set too (MICA-161)', () => {
    for (const column of ['participant_a', 'participant_b', 'pair_key']) {
      expect(conversations.resolved.columns).toContain(column);
      expect(conversations.repo['clientWritable']).not.toContain(column);
    }
  });
});

/**
 * MICA-161. `pair_key_unique` is what actually closes the gap `reconcilePairDuplicate`
 * (tested above) only narrows: a genuinely simultaneous insert for the same pair now fails
 * at the database rather than quietly producing two live threads.
 */
describe('conversations:create — participant_a/participant_b and the unique-index race', () => {
  /**
   * The row handed to the conversation insert, not the participant inserts, decoded into
   * a plain `{ column: value }` object — the two are positional in the SQL and the params
   * array, and re-deriving that mapping by hand in each assertion would just be this
   * function inlined and duplicated.
   */
  const conversationInsertColumns = (): Record<string, unknown> => {
    const call = dbMock.insert.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' && sql.includes('INSERT INTO `gphone_messages_conversations`')
    ) as [string, unknown[]] | undefined;
    if (!call) throw new Error('no insert into gphone_messages_conversations');
    const [sql, params] = call;
    const names = (sql.match(/\(([^)]+)\)/)?.[1] ?? '')
      .split(',')
      .map((c) => c.trim().replace(/`/g, ''));
    return Object.fromEntries(names.map((name, i) => [name, params[i]]));
  };

  beforeEach(() => {
    directory.byPhone.set('555-0100', { citizenid: 'CIT_B' });
  });

  it('stamps participant_a/participant_b on a 1:1 create', async () => {
    await call('create', { phone: '555-0100' });

    const columns = conversationInsertColumns();
    expect([columns.participant_a, columns.participant_b].sort()).toEqual(['CIT_A', 'CIT_B']);
  });

  it('writes participant_a/participant_b as null, not undefined, on a group create', async () => {
    directory.byPhone.set('555-0200', { citizenid: 'CIT_C' });

    await call('create', { phone: '555-0100', participants: ['555-0200'] });

    const columns = conversationInsertColumns();
    // `undefined` specifically, not merely falsy: `Object.keys` cannot tell an
    // explicit `undefined` from an absent key apart, and an `undefined` bind parameter
    // is a driver error rather than the SQL NULL a group thread's pair key needs.
    expect(columns.participant_a).toBeNull();
    expect(columns.participant_b).toBeNull();
  });

  it('resolves to the winner rather than throwing when the insert loses the pair_key race', async () => {
    const winner = { id: 555, citizenid: 'CIT_B', is_group: false };
    dbMock.insert.mockRejectedValueOnce(
      Object.assign(new Error("Duplicate entry 'CIT_A|CIT_B' for key 'pair_key_unique'"), {
        code: 'ER_DUP_ENTRY'
      })
    );
    // `findOneToOne` misses on the pre-check (nothing seeded yet) and then finds the
    // winner once the create fails — `dbMock.query` backs both calls, so the second
    // mockResolvedValueOnce is what the post-failure lookup sees.
    dbMock.query.mockResolvedValueOnce([]).mockResolvedValueOnce([winner]);

    const created = await call('create', { phone: '555-0100' });

    expect(created).toEqual(winner);
    // No participant rows were written for a create that never actually happened.
    expect(participantsAdded()).toEqual([]);
  });

  it('still throws when the create fails for a reason that has nothing to do with the pair key', async () => {
    dbMock.insert.mockRejectedValueOnce(new Error('ER_LOCK_WAIT_TIMEOUT: Lock wait timeout'));

    const reply = await call('create', { phone: '555-0100' });

    expect(reply).toMatchObject({ error: expect.stringContaining('Lock wait timeout') });
  });

  it('does not touch the duplicate-key fallback for a group thread, which has no pair', async () => {
    directory.byPhone.set('555-0200', { citizenid: 'CIT_C' });
    dbMock.insert.mockRejectedValueOnce(
      Object.assign(new Error("Duplicate entry 'x' for key 'pair_key_unique'"), {
        code: 'ER_DUP_ENTRY'
      })
    );

    const reply = await call('create', { phone: '555-0100', participants: ['555-0200'] });

    // No `pairCitizenId` for a group, so the catch re-throws unconditionally rather than
    // trying a `findOneToOne` lookup that could never apply to it.
    expect(reply).toMatchObject({ error: expect.stringContaining('Duplicate entry') });
  });
});
