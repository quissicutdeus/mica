// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { __resetRateLimits } from '../lib/rateLimit';
import type { CountingDatabase } from './queryCounter';

/**
 * MICA-212: a thread is read one page at a time, and what that costs is a constant.
 *
 * `messages:get` used to hand back the whole thread — every row, then every attachment in
 * the conversation — so a long thread cost its full weight on every open while the app
 * rendered fifty of it. Now it is one page, keyset on `id DESC`, and the statement count is
 * the same whatever the thread holds. Like `queryBudget.test.ts`, the budget is stated
 * against a growing N, because a count checked at one size is not a budget.
 *
 * The second thing held here is that a cursor is a bound and never authorization: the page
 * is selected by the caller's own `conversation_id` first, so a cursor lifted from another
 * thread reads nothing across.
 */

const { handlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return { handlers: captured };
});

vi.mock('../lib/Database', async () => {
  const { createCountingDatabase } = await import('./queryCounter');
  return { Database: createCountingDatabase() };
});

vi.mock('../lib/FrameworkBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/FrameworkBridge')>();
  class TestBridge extends actual.FrameworkBridge {
    static override getPlayer(source: number) {
      return source === CALLER_SOURCE
        ? ({ citizenid: CALLER, source, phone: null, rawPlayer: {}, setMeta: () => {} } as never)
        : null;
    }
  }
  return { ...actual, FrameworkBridge: TestBridge };
});

// Imported for its side effect: loading the module registers `gos:server:messages:get`.
import { messages } from '../services/Messages';
import { Database } from '../lib/Database';

const db = Database as unknown as CountingDatabase;

const CALLER = 'CIT_ME';
const CALLER_SOURCE = 5;
const PAGE = messages.resolved.paging!.pageSize;
const MAX_PAGE = messages.resolved.paging!.maxPageSize;

/** Every payload the caller's callback was answered with, in order. */
let replies: unknown[] = [];

beforeEach(() => {
  db.reset();
  replies = [];
  __resetRateLimits();
  (globalThis as any).source = CALLER_SOURCE;
  // `ServiceEndpoint` answers as `emitNet(replyEvent, source, cbId, result)`.
  (globalThis as any).emitNet = vi.fn(
    (_event: string, _target: number, _cbId: unknown, payload: unknown) => {
      replies.push(payload);
    }
  );
});

/** Drives `gos:server:messages:get` as the caller, a participant unless told otherwise. */
const get = async (data: unknown, { member = true } = {}) => {
  const handler = handlers.get('gos:server:messages:get');
  if (!handler) throw new Error('no handler for get');
  if (member) db.answerSingle(1);
  await handler('cb-1', data);
};

/** `n` rows as the page SELECT hands them back: newest first, ids descending from `top`. */
const rows = (n: number, top = 1000) =>
  Array.from({ length: n }, (_, index) => ({
    id: top - index,
    conversation_id: 7,
    citizenid: index % 2 === 0 ? CALLER : 'CIT_OTHER',
    message: `m${top - index}`,
    status: 'active',
    edited: 0,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00'
  }));

/** The one statement matching `pattern`, or a failure naming what was issued. */
const statement = (pattern: RegExp) => {
  const found = db.statements.filter((s) => pattern.test(s.sql));
  expect(found, `expected one statement matching ${pattern}`).toHaveLength(1);
  return found[0];
};

/** The page the handler answered with. */
const answered = () =>
  replies[replies.length - 1] as { rows: { id: number }[]; nextCursor: number | null };

describe('a thread page is three statements at most, whatever the thread holds', () => {
  for (const n of [1, PAGE, PAGE + 1]) {
    it(`costs exactly three statements when the SELECT answers ${n} row(s)`, async () => {
      db.answerQuery(rows(n), []);

      await get({ conversation_id: 7 });

      // Membership, the page, that page's attachments. Never one per message.
      expect(db.count()).toBe(3);
    });
  }

  it('spends them on membership, the page and one IN for its attachments', async () => {
    db.answerQuery(rows(3), []);

    await get({ conversation_id: 7 });

    expect(db.statements[0].method).toBe('single');
    expect(db.statements[0].sql).toContain('gos_messages_participants');
    expect(db.statements[1].sql).toContain('FROM gos_messages m');
    expect(db.statements[1].sql).toContain('ORDER BY m.id DESC');
    // Bound to the page's ids, not to the conversation: the old join re-hydrated every
    // attachment in the thread on every open.
    expect(db.statements[2].sql).toContain('FROM gos_messages_attachments a');
    expect(db.statements[2].sql).toContain('IN (?, ?, ?)');
    expect(db.statements[2].sql).not.toContain('conversation_id');
    expect(db.statements[2].params).toEqual([998, 999, 1000]);
  });

  it('costs two when the page is empty — there is nothing to hydrate', async () => {
    db.answerQuery([]);

    await get({ conversation_id: 7 });

    expect(db.count()).toBe(2);
    expect(answered()).toEqual({ rows: [], nextCursor: null });
  });

  it('reads nothing at all for someone who is not in the thread', async () => {
    await get({ conversation_id: 7 }, { member: false });

    expect(db.count()).toBe(1);
    expect(db.count(/FROM gos_messages m/)).toBe(0);
  });
});

describe('the page is a keyset on id, newest first, in reading order', () => {
  it('asks for one row more than the page and drops it, keeping its id as the cursor', async () => {
    db.answerQuery(rows(PAGE + 1), []);

    await get({ conversation_id: 7 });

    const page = statement(/FROM gos_messages m/);
    expect(page.sql).toContain('LIMIT ?');
    expect(page.params).toEqual([7, PAGE + 1]);

    const reply = answered();
    expect(reply.rows).toHaveLength(PAGE);
    // Oldest first within the page, so the client prepends without reversing.
    expect(reply.rows[0].id).toBe(1000 - PAGE + 1);
    expect(reply.rows[PAGE - 1].id).toBe(1000);
    // The lowest id handed back, exclusive: the next page starts strictly below it.
    expect(reply.nextCursor).toBe(1000 - PAGE + 1);
  });

  it('answers null for the cursor when the thread ends inside the page', async () => {
    db.answerQuery(rows(PAGE), []);

    await get({ conversation_id: 7 });

    expect(answered().nextCursor).toBeNull();
  });

  it('binds the cursor as an exclusive upper bound after the conversation', async () => {
    db.answerQuery(rows(2, 400), []);

    await get({ conversation_id: 7, cursor: 401 });

    const page = statement(/FROM gos_messages m/);
    expect(page.sql).toContain('m.conversation_id = ?');
    expect(page.sql).toContain('AND m.id < ?');
    expect(page.params).toEqual([7, 401, PAGE + 1]);
  });

  it('clamps an oversized limit to the declared maximum rather than refusing it', async () => {
    db.answerQuery(rows(1), []);

    await get({ conversation_id: 7, limit: 5000 });

    expect(statement(/FROM gos_messages m/).params).toEqual([7, MAX_PAGE + 1]);
  });

  it('never orders by created_at — an insert at the head must not shift the keyset', async () => {
    db.answerQuery(rows(1), []);

    await get({ conversation_id: 7 });

    expect(statement(/FROM gos_messages m/).sql).not.toContain('ORDER BY m.created_at');
  });
});

describe('a cursor is a bound, never authorization', () => {
  /**
   * The caller is in thread 7 and holds a row id from thread 9. Whatever that id is, the
   * SELECT is scoped to thread 7 first, so the cursor can only narrow the caller's own thread
   * — it cannot name a row in another one.
   */
  it("scopes the page to the caller's conversation before applying a foreign cursor", async () => {
    db.answerQuery(rows(1), []);

    await get({ conversation_id: 7, cursor: 9001 });

    const page = statement(/FROM gos_messages m/);
    expect(page.sql.indexOf('m.conversation_id = ?')).toBeLessThan(page.sql.indexOf('m.id < ?'));
    expect(page.params[0]).toBe(7);
    expect(page.params[1]).toBe(9001);
    // Membership was asked of thread 7, the one the caller named — not the cursor's.
    expect(db.statements[0].params).toEqual([7, CALLER]);
  });

  it('checks membership of the named thread; a non-member gets no page for any cursor', async () => {
    await get({ conversation_id: 9, cursor: 9001 }, { member: false });

    expect(db.count(/FROM gos_messages m/)).toBe(0);
    expect(db.statements[0].params).toEqual([9, CALLER]);
  });

  it('refuses a cursor that is not a row id', async () => {
    await get({ conversation_id: 7, cursor: 'not-an-id' });

    expect(db.count(/FROM gos_messages m/)).toBe(0);
  });
});
