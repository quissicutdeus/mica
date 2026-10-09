// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * MICA-339: what one member of a Messages thread learns about another.
 *
 * Before this, `conversations:get` spread each raw membership row (its `citizenid` and
 * `device_id`) and added the member's directory name and **active** number; every message row
 * carried its sender's citizenid; and the conversation row carried its creator's citizenid and
 * the pair's phone ids. Alice texting Bob from a burner and switching back to her main phone
 * was enough for Bob's phone to label the burner thread "Alice", from her main number, with
 * her citizenid on every message to match against her other threads.
 *
 * Every row here carries those fields the way the database hands them back, so a projection
 * that lets one through fails, and every negative check has a positive twin beside it.
 */

const { dbMock, handlers, data, fw } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured,
    /** What the routed `query` answers, by statement. */
    data: {
      threads: [] as Record<string, unknown>[],
      members: [] as object[],
      page: [] as Record<string, unknown>[]
    },
    fw: { kind: 'qb' }
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: 'CIT_A', source: 5, phone: '5550100', setMeta: () => {} }),
    getSourceByCitizenId: () => null,
    getSourcesByCitizenId: (ids: readonly string[]) =>
      new Map(ids.filter((id) => id === 'CIT_B').map((id) => [id, 6])),
    getPlayerByPhone: () => null
  },
  detectFramework: () => fw.kind
}));

/** The directory knows Bea by her character name and the number of the phone she holds now. */
const resolveMany = vi.hoisted(() =>
  vi.fn(async (ids: readonly string[]) => {
    const out = new Map<string, { citizenid: string; displayName: string; phone: string }>();
    for (const id of ids) {
      if (id === 'CIT_B')
        out.set(id, { citizenid: id, displayName: 'Bea Holder', phone: '5559999' });
    }
    return out;
  })
);
vi.mock('../lib/PlayerDirectory', () => ({
  resolveByPhone: async () => null,
  resolveMany
}));

import { messages } from '../services/Messages';
import { conversations } from '../services/Conversations';
import {
  conversationForReader,
  participantForReader,
  type ConversationRow,
  type ParticipantRow
} from '../repositories/ConversationRepository';
import {
  messageForReader,
  type MessageRepository,
  type MessageRow
} from '../repositories/MessageRepository';
import { NOT_HELD_REPLY, refusePhone, TEST_PHONE_ID } from './phoneStub';
import { responseEventFor } from '@mica/shared/rpc';

const call = async (service: string, action: string, payload: unknown) => {
  const handler = handlers.get(`mica:server:${service}:${action}`);
  if (!handler) throw new Error(`no handler for ${service}:${action}`);
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', payload);
  const calls = (globalThis.emitNet as any).mock.calls as any[][];
  return calls.filter((args) => args[0] === responseEventFor(service, action)).at(-1)?.[3];
};

/** Alice (CIT_A) on the phone in hand; Bea (CIT_B) on her burner, PHONE_BURNER. */
const NOW = '2026-10-08 12:00:00';
const member = (over: Record<string, unknown>): ParticipantRow =>
  ({
    conversation_id: 1,
    role: 'member',
    status: 'active',
    last_read: NOW,
    created_at: NOW,
    updated_at: NOW,
    left_at: null,
    ...over
  }) as ParticipantRow;
const ALICE = member({
  id: 10,
  citizenid: 'CIT_A',
  device_id: TEST_PHONE_ID,
  phone_number: '5550100'
});
const BEA = member({
  id: 11,
  citizenid: 'CIT_B',
  device_id: 'PHONE_BURNER',
  role: 'admin',
  phone_number: '5550222'
});

/** A 1:1 Bea started, as `findForPhone`'s flat SELECT returns it. */
const BURNER_THREAD = {
  id: 1,
  citizenid: 'CIT_B',
  is_group: 0,
  name: 'Bea Holder',
  participant_a: 'PHONE_BURNER',
  participant_b: TEST_PHONE_ID,
  pair_key: `PHONE_BURNER|${TEST_PHONE_ID}`,
  status: 'active',
  created_at: NOW,
  updated_at: NOW,
  unread_count: 1,
  last_message_text: 'meet me',
  last_message_time: NOW,
  last_message_sender: 'CIT_B',
  last_message_external: null,
  archived_at: null
};

beforeEach(() => {
  vi.clearAllMocks();
  fw.kind = 'qb';
  data.threads = [BURNER_THREAD];
  data.members = [ALICE, BEA];
  data.page = [];
  dbMock.query.mockImplementation(async (sql: string) => {
    if (
      sql.includes('FROM mica_messages_conversations c') &&
      sql.includes('JOIN mica_messages_participants me')
    )
      return data.threads;
    if (sql.includes('mica_messages_participants') && sql.includes('phone_number'))
      return data.members;
    if (sql.includes('FROM mica_messages m')) return data.page;
    return [];
  });
  dbMock.single.mockResolvedValue({ 1: 1 });
  dbMock.insert.mockResolvedValue(50);
  dbMock.update.mockResolvedValue(true);
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
});

/** Every value that would tell Alice who holds the burner, or link it to another thread. */
const IDENTIFYING = ['CIT_B', 'PHONE_BURNER', 'Bea Holder', '5559999', 'CIT_A', TEST_PHONE_ID];
const expectNoIdentity = (reply: unknown) => {
  const wire = JSON.stringify(reply);
  for (const value of IDENTIFYING) expect(wire, value).not.toContain(value);
};

describe('conversations:get — a member is the number on the phone in the thread', () => {
  it("sends no member's citizenid, phone id, directory name or active number", async () => {
    const reply = await call('conversations', 'get', {});

    expect(reply.rows).toHaveLength(1);
    expectNoIdentity(reply);
    // Not even asked: the directory's answer is the phone Bea holds now, which is the leak.
    expect(resolveMany).not.toHaveBeenCalled();
  });

  it("gives each member the burner's own number and says which one is the reader", async () => {
    const reply = await call('conversations', 'get', {});

    const [thread] = reply.rows;
    expect(thread.participants).toEqual([
      expect.objectContaining({ id: 10, self: true, phone: '5550100', role: 'member' }),
      expect.objectContaining({ id: 11, self: false, phone: '5550222', role: 'admin' })
    ]);
    expect(thread.participant_count).toBe(2);
  });

  it("drops the creator's citizenid, the pair's phone ids and a 1:1's stored name", async () => {
    const reply = await call('conversations', 'get', {});

    const [thread] = reply.rows;
    for (const key of ['citizenid', 'participant_a', 'participant_b', 'pair_key', 'name']) {
      expect(thread, key).not.toHaveProperty(key);
    }
    expect(thread).toMatchObject({ id: 1, is_group: false, unread_count: 1, status: 'active' });
  });

  it("tells the reader whether the last message is theirs, and which member's it is", async () => {
    const reply = await call('conversations', 'get', {});

    expect(reply.rows[0].last_message).toEqual({
      message: 'meet me',
      created_at: NOW,
      external_sender: null,
      mine: false,
      sender_id: 11
    });
  });

  it('keeps a group its name', async () => {
    data.threads = [
      { ...BURNER_THREAD, is_group: 1, name: 'Crew', participant_a: null, participant_b: null }
    ];

    const reply = await call('conversations', 'get', {});

    expect(reply.rows[0]).toMatchObject({ is_group: true, name: 'Crew' });
  });

  /**
   * es_extended keeps the number on the character and micaOS issues none, so the directory is
   * the only place it is — and every phone that character holds answers to it.
   */
  it('asks the directory for a number only on es_extended, and still never for a name', async () => {
    fw.kind = 'esx';
    data.members = [
      { ...ALICE, phone_number: null },
      { ...BEA, phone_number: null }
    ];

    const reply = await call('conversations', 'get', {});

    expect(reply.rows[0].participants[1]).toMatchObject({ self: false, phone: '5559999' });
    expect(JSON.stringify(reply)).not.toContain('Bea Holder');
    expect(JSON.stringify(reply)).not.toContain('CIT_B');
  });
});

describe('messages — a row says whose it is without naming anyone', () => {
  const row = (over: Record<string, unknown>) => ({
    conversation_id: 1,
    status: 'active',
    edited: 0,
    reply_to_id: null,
    external_sender: null,
    created_at: NOW,
    updated_at: NOW,
    ...over
  });

  it("hands a page back without any sender's citizenid", async () => {
    // Newest first, as the keyset reads it; the reply is in reading order (MICA-212).
    data.page = [
      row({ id: 9, citizenid: 'CIT_A', message: 'cab', sender_id: null, external_sender: 'Cab' }),
      row({ id: 8, citizenid: 'CIT_A', message: 'mine', sender_id: 10 }),
      row({ id: 7, citizenid: 'CIT_B', message: 'theirs', sender_id: 11 })
    ];

    const reply = await call('messages', 'get', { conversation_id: 1 });

    expectNoIdentity(reply);
    expect(reply.rows.map((m: any) => [m.id, m.mine, m.sender_id])).toEqual([
      [7, false, 11],
      [8, true, 10],
      // A line's text sits on the reader's row, and is still not theirs.
      [9, false, null]
    ]);
  });

  it('works out the sending member in the page read itself, never for a line', async () => {
    await call('messages', 'get', { conversation_id: 1 });

    const sql = String(
      dbMock.query.mock.calls.find(([s]) => String(s).includes('FROM mica_messages m'))?.[0]
    );
    expect(sql).toContain('CASE WHEN m.external_sender IS NULL THEN');
    expect(sql).toContain('p.citizenid = m.citizenid AND p.left_at IS NULL');
  });

  it('answers a send as the sender: theirs, by their own membership id', async () => {
    const reply = await call('messages', 'send', { conversation_id: 1, message: 'on my way' });

    expect(reply).toMatchObject({ id: 50, conversation_id: 1, mine: true, sender_id: 10 });
    expect(reply).not.toHaveProperty('citizenid');
  });

  it('pushes the other member the row as they would read it, with no name and no citizenid', async () => {
    await call('messages', 'send', { conversation_id: 1, message: 'on my way' });

    const push = ((globalThis.emitNet as any).mock.calls as unknown[][]).find(
      ([event]) => event === 'mica:client:messages:received'
    );
    expect(push?.[1]).toBe(6);
    const payload = push?.[2] as Record<string, any>;
    expect(payload.senderName).toBeUndefined();
    expect(payload.row).toMatchObject({ mine: false, sender_id: 10, message: 'on my way' });
    expect(JSON.stringify(payload)).not.toContain('CIT_A');
  });
});

describe('messages:send needs a phone in hand (MICA-339)', () => {
  it('refuses a text from a player holding no phone, before anything is written', async () => {
    refusePhone();

    const reply = await call('messages', 'send', { conversation_id: 1, message: 'on my way' });

    expect(reply).toEqual(NOT_HELD_REPLY);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('still reads a thread without one: only the write is refused', async () => {
    refusePhone();

    const reply = await call('messages', 'get', { conversation_id: 1 });

    expect(reply).toMatchObject({ rows: [], nextCursor: null });
  });
});

describe('conversations:update — rename is the admin on the phone in hand (F15)', () => {
  it('is a contracted action, with the generic owner-scoped update turned off', () => {
    expect(conversations.resolved.clientWritable).toContain('name');
    expect(handlers.has('mica:server:conversations:update')).toBe(true);
  });

  it('writes only through the admin membership, on the citizen and the phone together', async () => {
    const reply = await call('conversations', 'update', { id: 1, name: 'Crew' });

    expect(reply).toBe(true);
    expect(dbMock.update).toHaveBeenCalledTimes(1);
    const [sql, params] = dbMock.update.mock.calls[0];
    expect(String(sql)).toContain("p.role = 'admin' AND p.status = 'active' AND p.left_at IS NULL");
    expect(String(sql)).toContain('p.citizenid = ? AND p.device_id = ?');
    // Not the creator's row predicate the generic update wrote, which never moved on handover.
    expect(String(sql)).not.toMatch(/WHERE `id` = \? AND `citizenid` = \?/);
    expect(params).toEqual(['Crew', 1, 'CIT_A', TEST_PHONE_ID]);
  });

  it('answers false, as the generic update did, when the caller is not the admin', async () => {
    dbMock.update.mockResolvedValueOnce(false);

    await expect(call('conversations', 'update', { id: 1, name: 'Crew' })).resolves.toBe(false);
  });

  it('refuses a name wider than the column before anything is written', async () => {
    const reply = await call('conversations', 'update', { id: 1, name: 'x'.repeat(51) });

    expect(reply).toMatchObject({ error: expect.any(String) });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('writes nothing for a name that is only spaces', async () => {
    await expect(call('conversations', 'update', { id: 1, name: '   ' })).resolves.toBe(false);
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});

describe('the reader projections', () => {
  const conversationRow = (over: Partial<ConversationRow>): ConversationRow => ({
    id: 3,
    citizenid: 'CIT_B',
    is_group: false,
    name: 'Bea Holder',
    participant_a: 'PHONE_BURNER',
    participant_b: TEST_PHONE_ID,
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
    ...over
  });

  it("keeps a line's label, the only name a thread with a line has", () => {
    const thread = conversationForReader(
      conversationRow({ name: 'Downtown Cab', participant_b: 'ext:5550420' })
    );
    expect(thread).toMatchObject({ name: 'Downtown Cab', is_group: false });
    expect(thread).not.toHaveProperty('participant_b');
  });

  it('withholds a stored 1:1 name and every column it does not list', () => {
    const thread = conversationForReader({
      ...conversationRow({}),
      pair_key: 'x',
      archived_by: 'CIT_B'
    } as ConversationRow);
    expect(Object.keys(thread).sort()).toEqual(
      ['created_at', 'id', 'is_group', 'status', 'updated_at'].sort()
    );
  });

  it("is not the reader's own membership on another of their phones", () => {
    const otherPhone = participantForReader(
      { ...ALICE, device_id: 'PHONE_TWO' } as ParticipantRow,
      'CIT_A',
      TEST_PHONE_ID
    );
    expect(otherPhone.self).toBe(false);
    expect(participantForReader(ALICE, 'CIT_A', TEST_PHONE_ID).self).toBe(true);
  });

  it("never calls a line's text the reader's, even on the reader's row", () => {
    const text = messageForReader(
      {
        id: 1,
        conversation_id: 1,
        citizenid: 'CIT_A',
        message: 'outside',
        external_sender: 'Cab',
        sender_id: 10,
        created_at: NOW,
        updated_at: NOW
      } as MessageRow,
      'CIT_A'
    );
    expect(text).toMatchObject({ mine: false, sender_id: null, external_sender: 'Cab' });
    expect(text).not.toHaveProperty('citizenid');
  });
});

/**
 * A picture an admin moderated after it was sent stops showing (MICA-339); one its sender
 * deleted from their own gallery does not, because the recipient already received it. The stub
 * cannot run a join, so the attachment read here applies whatever status predicate the
 * statement carries to two pictures, one `deleted` and one `moderated`: a predicate of
 * `= 'active'` drops both and fails, `<> 'moderated'` keeps the first. Checked on MariaDB 11 too.
 */
describe('a moderated picture leaves the thread, a deleted one stays', () => {
  const repo = () => messages.repo as unknown as MessageRepository;
  const PICTURES = [
    {
      id: 1,
      message_id: 7,
      media_id: 20,
      kind: 'photo',
      data: 'deleted-by-owner',
      status: 'deleted'
    },
    { id: 2, message_id: 7, media_id: 21, kind: 'photo', data: 'moderated', status: 'moderated' }
  ];

  /** The rows a statement's `p.status` predicate admits, read off the statement itself. */
  const admittedBy = (sql: string) => {
    const not = /p\.status <> '(\w+)'/.exec(sql)?.[1];
    const only = /p\.status = '(\w+)'/.exec(sql)?.[1];
    return PICTURES.filter((row) => (not ? row.status !== not : only ? row.status === only : true));
  };

  it('shows a picture its sender deleted from their gallery, and hides a moderated one', async () => {
    data.page = [{ id: 7, conversation_id: 1, citizenid: 'CIT_B', message: 'look', sender_id: 11 }];
    const route = dbMock.query.getMockImplementation()!;
    dbMock.query.mockImplementation(async (sql: string, params: unknown[]) =>
      sql.includes('FROM mica_messages_attachments a') ? admittedBy(sql) : route(sql, params)
    );

    const { rows } = await repo().findByConversation(1, { limit: 50, cursor: null });

    expect(rows[0].attachments?.map((a) => a.media?.data)).toEqual(['deleted-by-owner']);
  });

  it("asks a line page's attachment flag of every picture but a moderated one", async () => {
    await repo().findLinePage(1, { limit: 20, cursor: null });

    const sql = String(dbMock.query.mock.calls.at(-1)?.[0]);
    expect(sql).toMatch(
      /EXISTS \(SELECT 1 FROM mica_messages_attachments a\s+JOIN mica_media p ON p\.id = a\.photo_id AND p\.status <> 'moderated'\s+WHERE a\.message_id = m\.id\)/
    );
    expect(admittedBy(sql).map((row) => row.status)).toEqual(['deleted']);
  });
});
