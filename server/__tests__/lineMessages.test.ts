// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Texts to a script's line (MICA-275): the `onMessage` half of `RegisterNumber`.
 *
 * The real `Conversations` and `Messages` services, driven through their registered net
 * events, over an in-memory stand-in for the three tables involved. A line has no `players`
 * row, so its thread is the one `SendMessage` already writes into (MICA-223): the pair
 * columns carry `ext:<number>`, and the player's phone is the only participant.
 */
const { handlers, db, players, directory } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    handlers: captured,
    db: {
      nextId: 1,
      conversations: new Map<number, Record<string, any>>(),
      participants: [] as {
        conversation_id: number;
        citizenid: string;
        phone_id: string;
        role: string;
        status: string;
        left_at: string | null;
      }[],
      messages: [] as Record<string, any>[],
      /** Every `query` statement, so a test can say which reads a path cost. */
      reads: [] as string[],
      /** Every `update` statement. */
      writes: [] as string[]
    },
    players: new Map<number, { citizenid: string; source: number; phone: string | null }>(),
    directory: new Map<string, { citizenid: string; displayName: string }>()
  };
});

/** The column list of an `INSERT INTO t (a, b) VALUES (?, ?)`, zipped with its values. */
const rowFrom = (sql: string, params: unknown[]): Record<string, any> => {
  const cols = /\(([^)]*)\)\s*VALUES/i.exec(sql)?.[1] ?? '';
  const names = cols.split(',').map((c) => c.trim().replace(/`/g, ''));
  return Object.fromEntries(names.map((name, i) => [name, params[i]]));
};

const activeConversation = (id: unknown) => {
  const row = db.conversations.get(Number(id));
  return row && row.status === 'active' ? row : undefined;
};

vi.mock('../lib/Database', () => ({
  Database: {
    insert: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO mica_messages_participants')) {
        const [conversation_id, citizenid, phone_id, role] = params as string[] as [
          number,
          string,
          string,
          string
        ];
        // The real statement's guard: no second live row for the same phone.
        if (
          db.participants.some(
            (p) => p.conversation_id === conversation_id && p.phone_id === phone_id && !p.left_at
          )
        ) {
          return 0;
        }
        // `conversation_phone_unique` holds a left row too.
        if (
          db.participants.some(
            (p) => p.conversation_id === conversation_id && p.phone_id === phone_id
          )
        ) {
          throw new Error("Duplicate entry for key 'conversation_phone_unique'");
        }
        db.participants.push({
          conversation_id,
          citizenid,
          phone_id,
          role,
          status: 'active',
          left_at: null
        });
        return db.nextId++;
      }
      if (sql.includes('`mica_messages_conversations`')) {
        const row = rowFrom(sql, params);
        const clash = [...db.conversations.values()].some(
          (c) =>
            c.status === 'active' &&
            row.participant_a &&
            [c.participant_a, c.participant_b].sort().join('|') ===
              [row.participant_a, row.participant_b].sort().join('|')
        );
        if (clash) throw new Error("Duplicate entry for key 'pair_key_unique'");
        const id = db.nextId++;
        db.conversations.set(id, { ...row, id, status: row.status ?? 'active' });
        return id;
      }
      if (sql.includes('`mica_messages`')) {
        const id = db.nextId++;
        db.messages.push({ ...rowFrom(sql, params), id });
        return id;
      }
      return db.nextId++;
    }),
    query: vi.fn(async (sql: string, params: unknown[]) => {
      db.reads.push(sql);
      if (sql.includes('SELECT c.participant_a, c.participant_b')) {
        const row = activeConversation(params[0]);
        return row ? [{ participant_a: row.participant_a, participant_b: row.participant_b }] : [];
      }
      if (sql.includes('c.participant_a = ? AND c.participant_b = ?')) {
        const [a, b] = params as string[];
        return [...db.conversations.values()].filter(
          (c) =>
            c.status === 'active' &&
            ((c.participant_a === a && c.participant_b === b) ||
              (c.participant_a === b && c.participant_b === a))
        );
      }
      if (sql.includes('mica_messages_participants') && !sql.includes('IN (')) {
        return db.participants.filter((p) => p.conversation_id === params[0] && !p.left_at);
      }
      return [];
    }),
    single: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('mica_messages_participants')) {
        const [conversationId, citizenid, phoneId] = params;
        return db.participants.some(
          (p) =>
            p.conversation_id === conversationId &&
            p.citizenid === citizenid &&
            !p.left_at &&
            (phoneId === undefined || p.phone_id === phoneId)
        )
          ? { 1: 1 }
          : null;
      }
      return null;
    }),
    update: vi.fn(async (sql: string, params: unknown[]) => {
      db.writes.push(sql);
      if (sql.includes('SET left_at = NULL')) {
        const [citizenid, conversationId, phoneId] = params as [string, number, string];
        const row = db.participants.find(
          (p) =>
            p.conversation_id === conversationId &&
            p.phone_id === phoneId &&
            p.status === 'left' &&
            p.left_at
        );
        if (!row) return false;
        Object.assign(row, { left_at: null, status: 'active', citizenid });
        return true;
      }
      if (sql.includes('SET left_at = CURRENT_TIMESTAMP')) {
        const [status, conversationId, citizenid, phoneId] = params as string[];
        const row = db.participants.find(
          (p) =>
            p.conversation_id === Number(conversationId) &&
            p.citizenid === citizenid &&
            p.phone_id === phoneId &&
            !p.left_at
        );
        if (!row) return false;
        Object.assign(row, { left_at: 'now', status });
        return true;
      }
      if (sql.includes('mica_messages_conversations') && params.includes('deleted')) {
        const row = db.conversations.get(Number(params.at(-1)));
        if (row) row.status = 'deleted';
        return true;
      }
      return true;
    }),
    scalar: vi.fn(async () => null)
  }
}));

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: (source: number) => {
      const p = players.get(source);
      return p ? { ...p, setMeta: () => {} } : null;
    },
    getPlayerByPhone: () => null,
    getSourceByCitizenId: () => null,
    getSourcesByCitizenId: (citizenids: readonly string[]) => {
      const found = new Map<string, number>();
      for (const p of players.values()) {
        if (citizenids.includes(p.citizenid)) found.set(p.citizenid, p.source);
      }
      return found;
    }
  }
}));

vi.mock('../lib/PlayerDirectory', () => ({
  resolveByPhone: async (phone: string) => directory.get(phone) ?? null,
  resolveMany: async () => new Map()
}));

const PHONE = '0123456789abcdef0123456789abcdef';
vi.mock('../services/Phones', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/Phones')>()),
  phoneForCitizen: async () => '0123456789abcdef0123456789abcdef'
}));

import '../services/Conversations';
import { sendFromLine } from '../services/Messages';
import {
  __resetRegistry,
  registerNumber,
  releaseResource,
  tellLine,
  unregisterNumber,
  type LineOptions,
  type RegisteredLine
} from '../lib/numberRegistry';
import { __resetRateLimits } from '../lib/rateLimit';

const PLAYER = { citizenid: 'CIT_A', source: 5, phone: '5550100' };
const LINE = '5550199';
const LINE_KEY = `ext:${LINE}`;
const OWNER = 'taxi_script';

/** Drives `mica:server:<service>:<action>` as PLAYER, and returns what it replied. */
const call = async (service: string, action: string, data: unknown) => {
  const handler = handlers.get(`mica:server:${service}:${action}`);
  if (!handler) throw new Error(`no handler for ${service}:${action}`);
  (globalThis as any).source = PLAYER.source;
  const emit = vi.fn();
  (globalThis as any).emitNet = emit;
  await handler('cb-1', data);
  const reply = emit.mock.calls.find(([event]) => String(event).includes(':response'));
  return { reply: (reply ?? emit.mock.calls.at(-1))?.[3], emit };
};

const register = (options: Partial<LineOptions> = {}) =>
  registerNumber(
    LINE,
    { onCall: () => ({ action: 'reject' }), label: 'Downtown Cab', ...options } as LineOptions,
    OWNER
  );

/** Let a fire-and-forget handler's promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db.nextId = 1;
  db.conversations.clear();
  db.participants.length = 0;
  db.messages.length = 0;
  db.reads.length = 0;
  db.writes.length = 0;
  players.clear();
  players.set(PLAYER.source, PLAYER);
  directory.clear();
  __resetRegistry();
  __resetRateLimits();
  (globalThis as any).GetConvar = (_n: string, fallback: string) => fallback;
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The player's thread with the line, opened from the Messages app. */
const openFromPhone = async () => (await call('conversations', 'create', { phone: LINE })).reply;

const lineThreads = () =>
  [...db.conversations.values()].filter(
    (c) => c.status === 'active' && [c.participant_a, c.participant_b].includes(LINE_KEY)
  );

describe('RegisterNumber takes onMessage', () => {
  it('refuses an onMessage that is not a function, rather than dropping it', () => {
    expect(register({ onMessage: 'reply' as any })).toMatchObject({
      ok: false,
      reason: 'invalid_args'
    });
  });

  it('still registers a line without one, which receives texts and tells nobody', () => {
    expect(register()).toMatchObject({ ok: true });
  });
});

/**
 * A line's number is its thread's key, lowercased. A number with letters in it could match a
 * name-only `SendMessage` thread from another resource, or a case-variant of itself, and hand
 * that thread's texts to the wrong script.
 */
describe("a line's number is a phone number", () => {
  const onCall = () => ({ action: 'reject' }) as const;

  it.each([
    'downtown cab',
    'Downtown Cab',
    'CAB',
    '555-CABS',
    'ext:5550199',
    '---',
    '+',
    '555\t0199'
  ])('refuses %j', (number) => {
    expect(registerNumber(number, { onCall }, OWNER)).toMatchObject({
      ok: false,
      reason: 'invalid_args'
    });
  });

  it.each(['5550199', '911', '+1 555 0199', '(555) 019-9', '555.0199'])('takes %j', (number) => {
    expect(registerNumber(number, { onCall }, OWNER)).toMatchObject({ ok: true });
  });

  it("does not hand a name-only SendMessage thread's replies to a line", async () => {
    const onMessage = vi.fn();
    // Another resource trying to claim the name as a number, differently cased.
    registerNumber(
      'downtown CAB',
      { onCall: () => ({ action: 'reject' }), onMessage } as LineOptions,
      'rival_script'
    );
    register({ onMessage });
    const { conversationId } = await sendFromLine(
      'CIT_A',
      { name: 'Downtown Cab', number: null },
      'Hi from a name',
      []
    );

    await call('messages', 'send', { conversation_id: conversationId, message: 'Who is this?' });

    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe('tellLine never fails its caller', () => {
  const line = (onMessage: RegisteredLine['onMessage']): RegisteredLine => ({
    number: LINE,
    owner: OWNER,
    blockable: true,
    label: null,
    job: null,
    onCall: () => ({ action: 'reject' }),
    onMessage
  });
  const text = {
    to: LINE,
    from: '5550100',
    source: 5,
    citizenid: 'CIT_A',
    body: 'hi',
    conversationId: 1,
    messageId: 2
  };

  it('logs a handler that throws', () => {
    expect(
      tellLine(
        line(() => {
          throw new Error('boom');
        }),
        text
      )
    ).toBe(true);
    expect(errors).toHaveBeenCalled();
  });

  it('logs a handler that rejects', async () => {
    tellLine(
      line(async () => {
        throw new Error('later');
      }),
      text
    );
    await settle();
    expect(errors).toHaveBeenCalled();
  });

  it('answers false when there is no handler to tell', () => {
    expect(tellLine(line(null), text)).toBe(false);
  });
});

describe('a player starting a thread with a line', () => {
  it('opens the line thread on the phone in hand, with the player its only participant', async () => {
    register();

    const thread = await openFromPhone();

    expect(thread).toMatchObject({
      is_group: false,
      name: 'Downtown Cab',
      participant_a: PHONE,
      participant_b: LINE_KEY
    });
    expect(db.participants).toEqual([
      expect.objectContaining({ conversation_id: thread.id, citizenid: 'CIT_A', phone_id: PHONE })
    ]);
  });

  it('reuses the thread the line opened by texting first', async () => {
    register();
    const first = await sendFromLine('CIT_A', { name: 'Downtown Cab', number: LINE }, 'Hi', []);

    const thread = await openFromPhone();

    expect(thread.id).toBe(first.conversationId);
    expect(lineThreads()).toHaveLength(1);
  });

  it('reaches a player, not the line, when a character holds the number', async () => {
    register();
    directory.set(LINE, { citizenid: 'CIT_B', displayName: 'Bea Real' });

    const thread = await openFromPhone();

    expect(thread.participant_b).not.toBe(LINE_KEY);
    expect(lineThreads()).toHaveLength(0);
  });

  it('refuses a number nobody holds, as before', async () => {
    const { reply } = await call('conversations', 'create', { phone: '5550000' });

    expect(reply).toBeNull();
    expect(db.conversations.size).toBe(0);
  });

  it('never puts a line in a group', async () => {
    register();

    await call('conversations', 'create', { phone: LINE, participants: ['5550300'] });

    expect(lineThreads()).toHaveLength(0);
  });
});

describe('a player texting a line', () => {
  it('writes the text as the player and hands it to onMessage', async () => {
    const onMessage = vi.fn();
    register({ onMessage });
    const thread = await openFromPhone();

    const { reply } = await call('messages', 'send', {
      conversation_id: thread.id,
      message: 'Pick me up at Legion.'
    });

    expect(reply).toMatchObject({ conversation_id: thread.id, citizenid: 'CIT_A' });
    expect(onMessage).toHaveBeenCalledWith({
      to: LINE,
      from: PLAYER.phone,
      source: PLAYER.source,
      citizenid: 'CIT_A',
      body: 'Pick me up at Legion.',
      conversationId: thread.id,
      messageId: reply.id
    });
  });

  it('still succeeds when the handler throws', async () => {
    register({
      onMessage: () => {
        throw new Error('script bug');
      }
    });
    const thread = await openFromPhone();

    const { reply } = await call('messages', 'send', { conversation_id: thread.id, message: 'hi' });

    expect(reply).toMatchObject({ conversation_id: thread.id, message: 'hi' });
    expect(reply.error).toBeUndefined();
    expect(db.messages).toHaveLength(1);
  });

  it('still succeeds when the handler rejects', async () => {
    register({ onMessage: () => Promise.reject(new Error('async script bug')) });
    const thread = await openFromPhone();

    const { reply } = await call('messages', 'send', { conversation_id: thread.id, message: 'hi' });
    await settle();

    expect(reply).toMatchObject({ message: 'hi' });
    expect(errors).toHaveBeenCalled();
  });

  /**
   * The bug this closes: before MICA-275, a player's reply in a `SendMessage` thread was
   * written and reached nobody, because the line holds no participant row to deliver to.
   */
  it("reaches onMessage when the player replies in the line's SendMessage thread", async () => {
    const onMessage = vi.fn();
    register({ onMessage });
    const { conversationId } = await sendFromLine(
      'CIT_A',
      { name: 'Downtown Cab', number: LINE },
      'Your ride is outside.',
      []
    );

    await call('messages', 'send', { conversation_id: conversationId, message: 'Coming.' });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0]).toMatchObject({ conversationId, body: 'Coming.' });
  });

  it("lands the script's reply in the same thread and pushes it live", async () => {
    register({ onMessage: vi.fn() });
    const thread = await openFromPhone();
    await call('messages', 'send', { conversation_id: thread.id, message: 'Cab please.' });

    const emit = vi.fn();
    (globalThis as any).emitNet = emit;
    const sent = await sendFromLine('CIT_A', { name: 'Downtown Cab', number: LINE }, 'On it.', []);

    expect(sent.conversationId).toBe(thread.id);
    expect(sent.delivered).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      'mica:client:messages:received',
      PLAYER.source,
      expect.objectContaining({ conversation_id: thread.id, message: 'On it.' })
    );
  });

  it('costs no extra read on a server with no lines registered', async () => {
    db.conversations.set(900, { id: 900, status: 'active', participant_a: PHONE });
    db.participants.push({ conversation_id: 900, citizenid: 'CIT_A', phone_id: PHONE });

    await call('messages', 'send', { conversation_id: 900, message: 'hi' });

    expect(db.reads.some((sql) => sql.includes('SELECT c.participant_a, c.participant_b'))).toBe(
      false
    );
  });
});

/** §2.9: nothing a client sends makes a player's words the line's. */
describe('a player can never send as a line', () => {
  it('ignores or refuses a send payload naming the line as its sender', async () => {
    register({ onMessage: vi.fn() });
    const thread = await openFromPhone();

    const { reply } = await call('messages', 'send', {
      conversation_id: thread.id,
      message: 'I am the cab company.',
      citizenid: LINE_KEY,
      external_sender: 'Downtown Cab'
    });

    // Either the contract refused the payload outright or the row was written; not neither,
    // or the loop below would pass on nothing.
    expect(Boolean(reply?.error) || db.messages.length === 1).toBe(true);
    for (const row of db.messages) {
      expect(row.citizenid).toBe('CIT_A');
      expect(row.external_sender ?? null).toBeNull();
    }
  });

  it('cannot open a line thread by naming the key instead of a registered number', async () => {
    await call('conversations', 'create', { phone: LINE_KEY });
    await call('conversations', 'create', { phone: LINE, participant_b: LINE_KEY });

    expect(lineThreads()).toHaveLength(0);
  });

  it("cannot edit or unsend the line's own text in the thread", async () => {
    register();
    await sendFromLine('CIT_A', { name: 'Downtown Cab', number: LINE }, 'Fare: $40', []);
    const lineRow = db.messages[0];

    const { reply } = await call('messages', 'edit', { id: lineRow.id, message: 'Fare: $0' });

    expect(reply).toMatchObject({ error: expect.any(String) });
  });
});

describe('when the line goes away', () => {
  it('keeps the thread and the text, and tells nobody, once unregistered', async () => {
    const onMessage = vi.fn();
    register({ onMessage });
    const thread = await openFromPhone();
    unregisterNumber(LINE, OWNER);

    const { reply } = await call('messages', 'send', { conversation_id: thread.id, message: 'hi' });

    expect(reply).toMatchObject({ message: 'hi' });
    expect(onMessage).not.toHaveBeenCalled();
    expect(lineThreads()).toHaveLength(1);
  });

  it('picks the same thread back up when the number is registered again after a restart', async () => {
    const before = vi.fn();
    register({ onMessage: before });
    const thread = await openFromPhone();
    releaseResource(OWNER);

    const after = vi.fn();
    register({ onMessage: after });
    await call('messages', 'send', { conversation_id: thread.id, message: 'still there?' });

    expect(before).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledWith(expect.objectContaining({ conversationId: thread.id }));
  });
});

/** Seeds a thread and its participants directly, as rows written before this change. */
const seed = (
  thread: Record<string, any>,
  members: { citizenid: string; phone_id: string; role?: string; left?: boolean }[]
) => {
  db.conversations.set(thread.id, { status: 'active', is_group: 0, ...thread });
  for (const m of members) {
    db.participants.push({
      conversation_id: thread.id,
      citizenid: m.citizenid,
      phone_id: m.phone_id,
      role: m.role ?? 'member',
      status: m.left ? 'left' : 'active',
      left_at: m.left ? 'earlier' : null
    });
  }
};

/**
 * A player who left a line thread before MICA-275 made leaving delete it: the thread is still
 * active, so the line found it again, but the player had no membership and every send into it
 * was refused. Opening it restores the phone's own row rather than inserting a second one,
 * which `conversation_phone_unique` would refuse.
 */
describe('a line thread the player left before leaving deleted it', () => {
  const stranded = () =>
    seed({ id: 500, participant_a: PHONE, participant_b: LINE_KEY, name: 'Downtown Cab' }, [
      { citizenid: 'CIT_A', phone_id: PHONE, left: true }
    ]);

  it("is restored when the line texts again, and the player's reply reaches it", async () => {
    const onMessage = vi.fn();
    register({ onMessage });
    stranded();

    const sent = await sendFromLine('CIT_A', { name: 'Downtown Cab', number: LINE }, 'Back?', []);
    const { reply } = await call('messages', 'send', { conversation_id: 500, message: 'Yes.' });

    expect(sent.conversationId).toBe(500);
    expect(reply).toMatchObject({ conversation_id: 500, message: 'Yes.' });
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 500 }));
    expect(db.participants.filter((p) => p.conversation_id === 500)).toEqual([
      expect.objectContaining({ citizenid: 'CIT_A', phone_id: PHONE, left_at: null })
    ]);
  });

  it('is restored when the player opens it from the phone', async () => {
    register();
    stranded();

    const thread = await openFromPhone();

    expect(thread.id).toBe(500);
    expect(db.participants.filter((p) => !p.left_at)).toHaveLength(1);
  });

  it('never reopens a membership that was removed rather than left', async () => {
    register();
    seed({ id: 501, participant_a: PHONE, participant_b: LINE_KEY }, [
      { citizenid: 'CIT_A', phone_id: PHONE }
    ]);
    const row = db.participants[0];
    Object.assign(row, { status: 'moderated', left_at: 'earlier' });

    await expect(
      sendFromLine('CIT_A', { name: 'Downtown Cab', number: LINE }, 'Hi', [])
    ).rejects.toThrow(/conversation_phone_unique/);
    expect(row.status).toBe('moderated');
  });
});

/** The delete branch MICA-275 added reaches only a thread with a line. */
describe('leaving a thread without a line', () => {
  const OTHER_PHONE = 'fedcba9876543210fedcba9876543210';
  const deleted = (id: number) => db.conversations.get(id)?.status === 'deleted';
  const own = (id: number) =>
    db.participants.find((p) => p.conversation_id === id && p.citizenid === 'CIT_A');

  it('only leaves a one-to-one with another player', async () => {
    seed({ id: 600, participant_a: PHONE, participant_b: OTHER_PHONE }, [
      { citizenid: 'CIT_A', phone_id: PHONE },
      { citizenid: 'CIT_B', phone_id: OTHER_PHONE, role: 'admin' }
    ]);

    await call('conversations', 'delete', { id: 600 });

    expect(deleted(600)).toBe(false);
    expect(own(600)).toMatchObject({ status: 'left' });
  });

  it('only leaves a group', async () => {
    seed({ id: 601, is_group: 1, participant_a: null, participant_b: null }, [
      { citizenid: 'CIT_A', phone_id: PHONE },
      { citizenid: 'CIT_B', phone_id: OTHER_PHONE, role: 'admin' },
      { citizenid: 'CIT_C', phone_id: 'aaaabbbbccccddddaaaabbbbccccdddd' }
    ]);

    await call('conversations', 'delete', { id: 601 });

    expect(deleted(601)).toBe(false);
    expect(own(601)).toMatchObject({ status: 'left' });
  });

  it('refuses a caller who is not in the thread, line or not', async () => {
    seed({ id: 602, participant_a: OTHER_PHONE, participant_b: LINE_KEY }, [
      { citizenid: 'CIT_B', phone_id: OTHER_PHONE }
    ]);

    const { reply } = await call('conversations', 'delete', { id: 602 });

    expect(reply).toMatchObject({ error: expect.any(String) });
    expect(deleted(602)).toBe(false);
    expect(db.writes).toHaveLength(0);
  });
});

describe('leaving a thread with a line', () => {
  /**
   * Leaving used to strand it: the line kept writing into a thread the player was no longer a
   * member of, found by its pair columns, so every later text from that number was invisible.
   */
  it('deletes it, so the next text from the line opens a thread the player can see', async () => {
    register();
    const { conversationId } = await sendFromLine(
      'CIT_A',
      { name: 'Downtown Cab', number: LINE },
      'Hi',
      []
    );

    await call('conversations', 'delete', { id: conversationId });
    const next = await sendFromLine('CIT_A', { name: 'Downtown Cab', number: LINE }, 'Again', []);

    expect(db.conversations.get(conversationId)?.status).toBe('deleted');
    expect(next.conversationId).not.toBe(conversationId);
  });
});
