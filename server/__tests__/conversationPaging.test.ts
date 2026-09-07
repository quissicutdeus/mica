// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { __resetRateLimits } from '../lib/rateLimit';
import type { CountingDatabase } from './queryCounter';

/**
 * MICA-211: the inbox pages by last-message recency, so a page can be a screenful.
 *
 * `conversations:get` used to keyset on `c.id DESC` while the inbox is displayed in order of
 * *when a thread was last written in*. Those are different orders, and the difference is not
 * cosmetic: an old thread somebody texts daily has a low id and a recent last message, so a
 * page walked by id left it for a later page while quieter, newer threads came first. The only
 * thing keeping that invisible was the page size — 200, above any real list — which is exactly
 * what stopped the inbox from being paged like everything else.
 *
 * So what is held here is the order rather than the count (`queryBudget.test.ts` still holds
 * the count). The first case is the ticket stated as a test: a thread with the lowest id and
 * the newest message is on page one at any page size, including a page of one, which is the
 * assertion `id DESC` cannot pass at any size below the whole list.
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

// Imported for its side effect: loading the module registers
// `mica:server:conversations:get`, and for the declaration's own paging numbers.
import { conversations } from '../services/Conversations';
import { Database } from '../lib/Database';
import { TEST_PHONE_ID } from './phoneStub';

const db = Database as unknown as CountingDatabase;

const CALLER = 'CIT_ME';
const CALLER_SOURCE = 5;
const PAGE = conversations.resolved.paging!.pageSize;
const MAX_PAGE = conversations.resolved.paging!.maxPageSize;

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

/** Drives `mica:server:conversations:get` as the caller. */
const get = async (data: unknown) => {
  const handler = handlers.get('mica:server:conversations:get');
  if (!handler) throw new Error('no handler for get');
  await handler('cb-1', data);
  return replies[replies.length - 1] as {
    rows: { id: number }[];
    nextCursor: { time: string; id: number } | null;
  };
};

/**
 * A row as `findForCitizen`'s own SELECT hands it back: the conversation, plus the last
 * message flattened onto it. The counting `Database` does not execute SQL, so the fixture is
 * what the query *would* have returned — already in the sort order the query declares.
 */
const row = (id: number, lastMessageTime: string | null) => ({
  id,
  citizenid: CALLER,
  is_group: 0,
  name: null,
  status: 'active',
  unread_count: 0,
  created_at: '2020-01-01 00:00:00',
  updated_at: lastMessageTime ?? '2020-01-01 00:00:00',
  last_message_text: lastMessageTime ? 'hi' : null,
  last_message_time: lastMessageTime,
  last_message_sender: 'CIT_THEM'
});

describe('the first page is the most recently messaged threads, whatever their ids', () => {
  /**
   * The ticket, as an assertion.
   *
   * Thread 1 is the oldest row in the table and the newest in the inbox — the "old thread
   * somebody texts daily" case. It comes first at every page size this service accepts,
   * including one, because the order the SQL declares is the order it is asked for. Under the
   * old `ORDER BY c.id DESC` the same fixture put thread 90 first and thread 1 last.
   */
  for (const limit of [1, 2, PAGE, MAX_PAGE]) {
    it(`puts a low-id, recently-messaged thread on page one at limit ${limit}`, async () => {
      db.answerQuery(
        [
          row(1, '2026-09-01 12:00:00'), // oldest id, newest message
          row(90, '2026-08-01 12:00:00'),
          row(70, '2026-07-01 12:00:00')
        ],
        []
      );

      const reply = await get({ limit });

      expect(reply.rows[0].id).toBe(1);
    });
  }

  /** The order is the query's, and this is the clause that states it. */
  it('sorts by the last message time, then by id, both descending', async () => {
    db.answerQuery([row(1, '2026-09-01 12:00:00')], []);

    await get({});

    const sql = db.statements[0].sql;
    expect(sql).toContain('ORDER BY COALESCE(m.`created_at`, c.`updated_at`) DESC, c.`id` DESC');
  });

  /**
   * `COALESCE`, not `m.created_at` alone: a thread nobody has written in yet has no message
   * row to take a time from, and sorting it as `NULL` would park every fresh conversation at
   * the bottom of the inbox — including the one the player just started, which is the one they
   * are about to type into. `c.updated_at` is what the client falls back to for `lastMessageAt`
   * too, so the two orders stay the same order.
   */
  it('orders a thread with no messages by its own updated_at', async () => {
    db.answerQuery([row(1, null), row(2, '2020-06-01 00:00:00')], []);

    const reply = await get({});

    // The fixture is what the SQL would return; what is asserted is that the sort key names
    // both columns rather than only the message's.
    expect(db.statements[0].sql).toContain('COALESCE(m.`created_at`, c.`updated_at`)');
    expect(reply.rows).toHaveLength(2);
  });
});

describe('the cursor is a position in that order, and a bound rather than authorization', () => {
  /**
   * Both halves of the compound keyset, in bind order. The `=` arm is not redundant: two
   * threads can share a timestamp to the second, and without the id tiebreak the boundary
   * between one page and the next either repeats those rows or skips them.
   */
  it('asks for rows strictly past the cursor, time first and id as the tiebreak', async () => {
    db.answerQuery([row(4, '2026-01-01 00:00:00')], []);

    await get({ cursor: { time: '2026-05-05 05:05:05', id: 12 }, limit: 10 });

    const { sql, params } = db.statements[0];
    expect(sql).toContain(
      'AND (COALESCE(m.`created_at`, c.`updated_at`) < ? OR (COALESCE(m.`created_at`, c.`updated_at`) = ? AND c.`id` < ?))'
    );
    // The caller's own citizenid first — the join that makes this their inbox and not anyone
    // else's — then the cursor's two halves, then the limit. A cursor never widens that join.
    expect(params).toEqual([
      CALLER,
      TEST_PHONE_ID,
      '2026-05-05 05:05:05',
      '2026-05-05 05:05:05',
      12,
      11
    ]);
  });

  /** No cursor means no predicate at all, rather than a sentinel date to compare against. */
  it('omits the predicate entirely on a first page', async () => {
    db.answerQuery([row(1, '2026-01-01 00:00:00')], []);

    await get({});

    expect(db.statements[0].sql).not.toContain('OR (COALESCE');
    expect(db.statements[0].params).toEqual([CALLER, TEST_PHONE_ID, PAGE + 1]);
  });

  /**
   * A cursor missing either half is refused rather than half-honoured. Half a position is not
   * a position, and silently dropping the id would make the page boundary approximate exactly
   * where two threads share a timestamp.
   */
  for (const bad of [
    { time: '2026-05-05 05:05:05' },
    { id: 12 },
    { time: 'yesterday', id: 12 },
    { time: '2026-05-05 05:05:05', id: 0 }
  ]) {
    it(`refuses a malformed cursor ${JSON.stringify(bad)}`, async () => {
      db.answerQuery([], []);

      await get({ cursor: bad });

      // The read never happens: the contract or `recencyCursor` refuses first.
      expect(db.count(/mica_messages_conversations/)).toBe(0);
    });
  }
});

describe('the reply says where the next page starts, rather than leaving it to be inferred', () => {
  /**
   * One row more than the page is asked for and dropped, so `nextCursor` is a fact rather than
   * a guess from a short page. The cursor is the *last kept* row's position, not the extra
   * row's — the extra row is the first of the next page and must not be skipped.
   */
  it('drops the probe row and points at the last row it kept', async () => {
    db.answerQuery(
      [
        row(1, '2026-09-01 12:00:00'),
        row(2, '2026-08-01 12:00:00'),
        row(3, '2026-07-01 12:00:00') // the probe: asked for, never returned
      ],
      []
    );

    const reply = await get({ limit: 2 });

    expect(db.statements[0].params).toEqual([CALLER, TEST_PHONE_ID, 3]);
    expect(reply.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(reply.nextCursor).toEqual({ time: '2026-08-01 12:00:00', id: 2 });
  });

  /** A page that did not fill is the end of the list, and says so. */
  it('answers a null cursor when the page is not full', async () => {
    db.answerQuery([row(1, '2026-09-01 12:00:00')], []);

    const reply = await get({ limit: 25 });

    expect(reply.nextCursor).toBeNull();
  });

  /** No threads at all is still the paged shape, not a bare array. */
  it('answers the paged shape for an empty inbox', async () => {
    db.answerQuery([]);

    const reply = await get({});

    expect(reply).toEqual({ rows: [], nextCursor: null });
  });

  /**
   * A `Date` from the driver and a string from the driver have to produce the same cursor —
   * oxmysql answers a `timestamp` as either depending on the build, and a cursor that differs
   * by build is a page boundary that only advances on some servers.
   */
  it('normalises a Date timestamp to the same string a cursor carries', async () => {
    db.answerQuery(
      [
        { ...row(1, null), last_message_time: new Date('2026-09-01T12:00:00Z') },
        row(2, '2026-08-01 12:00:00')
      ],
      []
    );

    const reply = await get({ limit: 1 });

    expect(reply.nextCursor).toEqual({ time: '2026-09-01 12:00:00', id: 1 });
  });

  /** An over-large `limit` is clamped, not refused — the request is legitimate, the number is not. */
  it('clamps a limit above the declared maximum', async () => {
    db.answerQuery([row(1, '2026-09-01 12:00:00')], []);

    await get({ limit: MAX_PAGE + 500 });

    expect(db.statements[0].params).toEqual([CALLER, TEST_PHONE_ID, MAX_PAGE + 1]);
  });
});
