// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Editing and unsending a message (MICA-68).
 *
 * `mica_messages` is the awkward table: `citizenid` is the **sender**, and the rows are
 * shared between everyone in the thread. So neither authorization question is sufficient on
 * its own — ownership says whether you wrote it, membership says whether you are still in
 * the conversation it belongs to, and both have to hold. §2.9's rule that a row id is never
 * authorization is what these assertions are really guarding.
 *
 * The sharpest of them is `it('checks membership on the row's conversation, not the
 * payload's')`. A caller controls every field, so supplying a conversation they *are* in
 * while naming a message from one they are not would pass a membership check written the
 * obvious way.
 */

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

import { messages } from '../services/Messages';
import { MessageRepository } from '../repositories/MessageRepository';
import { __resetRateLimits } from '../lib/rateLimit';

/** The row `findById` will answer with, or null for "no such message of yours". */
const world = {
  row: null as Record<string, unknown> | null,
  isMember: true
};

const call = async (action: string, data: unknown) => {
  const handler = handlers.get(`mica:server:messages:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

/** Every `UPDATE mica_messages …` the call issued, as `[sql, params]`. */
const messageUpdates = () =>
  dbMock.update.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && sql.includes('`mica_messages`')
  );

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  world.row = {
    id: 42,
    conversation_id: 7,
    citizenid: 'CIT_A',
    status: 'active',
    message: 'origianl'
  };
  world.isMember = true;

  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(1);
  dbMock.update.mockResolvedValue(true);
  // Both `findById` and `isMember` go through `Database.single`; the statement says which.
  dbMock.single.mockImplementation(async (sql: string) =>
    sql.includes('mica_messages_participants') ? (world.isMember ? 1 : null) : world.row
  );
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
});

describe('messages:edit — who may rewrite what', () => {
  it('rewrites the body with the ownership predicate in the WHERE', async () => {
    const reply = await call('edit', { id: 42, message: 'original' });

    expect(reply).toMatchObject({ id: 42, message: 'original', edited: true });

    const [sql, params] = messageUpdates()[0];
    expect(sql).toContain('`message` = ?');
    expect(sql).toContain('`citizenid` = ?');
    expect(params).toEqual(['original', 42, 'CIT_A']);
  });

  it('refuses a message the caller did not send, and writes nothing', async () => {
    // `findById(id, citizenid)` is ownership-scoped, so somebody else's row simply is not
    // found. The point of the assertion is the second half: no UPDATE was attempted.
    world.row = null;

    const reply = await call('edit', { id: 42, message: 'not mine' });

    expect(reply).toMatchObject({
      error: 'That message is not yours to change.',
      key: 'server.messages.notYours'
    });
    expect(messageUpdates()).toEqual([]);
  });

  it('refuses somebody who has left the conversation', async () => {
    world.isMember = false;

    const reply = await call('edit', { id: 42, message: 'still here?' });

    expect(reply).toMatchObject({
      error: 'Not a participant in this conversation.',
      key: 'server.messages.notParticipant'
    });
    expect(messageUpdates()).toEqual([]);
  });

  it("checks membership on the row's conversation, and refuses a payload naming one", async () => {
    await call('edit', { id: 42, message: 'reaching' });

    const membershipCalls = dbMock.single.mock.calls.filter(([sql]) =>
      String(sql).includes('mica_messages_participants')
    );
    expect(membershipCalls).toHaveLength(1);
    // 7 is the row's own conversation, read off the row and never off the payload.
    expect(membershipCalls[0][1]).toEqual([7, 'CIT_A']);

    // A caller naming their own thread while editing a message from one they are not in was
    // already ignored; `edit`'s contract declares no `conversation_id` at all, so the request
    // carrying one is refused before any of this runs.
    dbMock.single.mockClear();
    const reply = await call('edit', { id: 42, conversation_id: 999, message: 'reaching' });

    expect(reply).toMatchObject({ error: expect.stringContaining('conversation_id') });
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('refuses an empty body rather than emptying the message', async () => {
    const reply = await call('edit', { id: 42, message: '   ' });

    expect(reply).toMatchObject({
      error: 'A message needs some text. Unsend it instead of emptying it.',
      key: 'server.messages.emptyEdit'
    });
    expect(messageUpdates()).toEqual([]);
  });

  it('refuses a message that is already deleted or moderated', async () => {
    world.row = { ...world.row, status: 'moderated' };

    const reply = await call('edit', { id: 42, message: 'sneaking it back' });

    expect(reply).toMatchObject({
      error: 'That message is no longer available.',
      key: 'server.messages.noLongerAvailable'
    });
    expect(messageUpdates()).toEqual([]);
  });

  it('does not write, or claim an edit, when the text is unchanged', async () => {
    // MySQL reports rows *changed*, so an identical value comes back as a failed update —
    // and an `ON UPDATE CURRENT_TIMESTAMP` that never fired would leave the row honestly
    // unedited while the UI had already raised the marker.
    const reply = await call('edit', { id: 42, message: 'origianl' });

    expect(messageUpdates()).toEqual([]);
    expect(reply).toEqual({ id: 42, conversation_id: 7, message: 'origianl' });
    expect(reply).not.toHaveProperty('edited');
  });

  it('rejects an id that is not a positive row id', async () => {
    const reply = await call('edit', { id: -1, message: 'hi' });

    expect(reply).toMatchObject({ error: expect.stringContaining('id') });
    expect(dbMock.single).not.toHaveBeenCalled();
  });
});

describe('messages:delete — an unsend, soft in the schema', () => {
  it('soft-deletes with the ownership predicate, and never issues a DELETE', async () => {
    const reply = await call('delete', { id: 42 });

    expect(reply).toBe(true);

    const [sql, params] = messageUpdates()[0];
    expect(sql).toContain('`status` = ?');
    expect(sql).toContain('`citizenid` = ?');
    expect(params).toEqual(['deleted', 42, 'CIT_A']);

    const hardDeletes = dbMock.query.mock.calls.filter(([q]) => /DELETE\s+FROM/i.test(String(q)));
    expect(hardDeletes).toEqual([]);
  });

  it('is not time-boxed — withdrawing what you said stays possible forever', async () => {
    // `Repository.delete` passes `enforceEditWindow: false` deliberately. The absence of a
    // recency predicate here is the whole assertion.
    await call('delete', { id: 42 });

    const [sql] = messageUpdates()[0];
    expect(sql).not.toContain('INTERVAL');
  });

  it('refuses a message the caller did not send', async () => {
    world.row = null;

    const reply = await call('delete', { id: 42 });

    expect(reply).toMatchObject({
      error: 'That message is not yours to change.',
      key: 'server.messages.notYours'
    });
    expect(messageUpdates()).toEqual([]);
  });

  it('refuses somebody who has left the conversation', async () => {
    world.isMember = false;

    const reply = await call('delete', { id: 42 });

    expect(reply).toMatchObject({
      error: 'Not a participant in this conversation.',
      key: 'server.messages.notParticipant'
    });
    expect(messageUpdates()).toEqual([]);
  });

  it('records the removal in the audit ledger', async () => {
    await call('delete', { id: 42 });

    const audits = dbMock.insert.mock.calls.filter(([sql]) =>
      String(sql).includes('mica_audit_logs')
    );
    expect(audits).toHaveLength(1);
    expect(audits[0][1]).toEqual(
      expect.arrayContaining(['CIT_A', 'deleted', 'messages', 42, 'mica_messages'])
    );
  });
});

describe('the edited marker is derived, not stored', () => {
  const repo = () => new MessageRepository(messages.resolved);

  it('asks MySQL for `updated_at > created_at` rather than adding a column', async () => {
    dbMock.query.mockResolvedValue([]);

    await repo().findByConversation(7);

    const [sql] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('(m.updated_at > m.created_at) AS edited');
    // The column is not in the schema, so nothing could have selected it by name.
    expect(messages.resolved.columns).not.toContain('edited');
  });

  it('normalises MySQL 1/0 to a real boolean', async () => {
    // As the page SELECT answers: newest first. The page comes back in reading order.
    dbMock.query
      .mockResolvedValueOnce([
        { id: 2, conversation_id: 7, message: 'b', edited: 1 },
        { id: 1, conversation_id: 7, message: 'a', edited: 0 }
      ])
      .mockResolvedValueOnce([]);

    const { rows } = await repo().findByConversation(7);

    expect(rows.map((r) => [r.id, r.edited])).toEqual([
      [1, false],
      [2, true]
    ]);
  });

  it('still hides an unsent message from every participant', async () => {
    dbMock.query.mockResolvedValue([]);

    await repo().findByConversation(7);

    expect(String(dbMock.query.mock.calls[0][0])).toContain("m.status != 'deleted'");
  });
});
