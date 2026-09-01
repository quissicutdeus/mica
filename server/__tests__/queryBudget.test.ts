// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { __resetRateLimits } from '../lib/rateLimit';
import type { CountingDatabase } from './queryCounter';

/**
 * MICA-197: how many statements an action costs, as a fact a suite can fail on.
 *
 * Every other server suite asserts what a query *says*. None of them could say how many
 * there were, and that is exactly the shape of the bug this file exists for: the conversation
 * list issued one hydration query per thread and a send issued a blocklist query per
 * recipient, and each of those queries was individually correct and individually tested. A
 * 1+N read passes a SQL-text assertion precisely as well as a batched one does, which is why
 * both survived for as long as they did.
 *
 * So the assertions here are counts, and they are stated **against a growing N**. A budget
 * checked at one size is not a budget: two participants and two queries could as easily be
 * one-per-participant as it could be a constant. Every case below runs the same action at
 * three sizes and expects the same number.
 */

const { framework, handlers, emitted } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };

  return {
    handlers: captured,
    emitted: [] as { event: string; target: number }[],
    /**
     * Who is connected, and what the framework's character table looks like — both as
     * mutable boxes, because a budget has to hold whether everyone is online (no offline
     * lookup) or nobody is (the join is the only source of a name).
     */
    framework: {
      online: new Map<string, number>(),
      /** What `ownerNameProjection` answers. `null` is standalone: no character table. */
      projection: null as { join: string; columns: string } | null
    }
  };
});

/**
 * The counting `Database`, built through a dynamic import because `vi.mock`'s factory is
 * hoisted above the static imports at the top of this file. It never reaches a connection —
 * `queryCounter` does not import `../lib/Database`, which is the module that reads
 * `exports.oxmysql` in module scope.
 */
vi.mock('../lib/Database', async () => {
  const { createCountingDatabase } = await import('./queryCounter');
  return { Database: createCountingDatabase() };
});

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: (source: number) => {
      for (const [citizenid, src] of framework.online) {
        if (src === source)
          return { citizenid, source, phone: null, rawPlayer: {}, setMeta: () => {} };
      }
      return source === CALLER_SOURCE
        ? { citizenid: CALLER, source, phone: null, rawPlayer: {}, setMeta: () => {} }
        : null;
    },
    getSourceByCitizenId: (citizenid: string) => framework.online.get(citizenid) ?? null,
    getSourcesByCitizenId: (citizenids: readonly string[]) => {
      const found = new Map<string, number>();
      for (const citizenid of citizenids) {
        const src = framework.online.get(citizenid);
        if (src !== undefined) found.set(citizenid, src);
      }
      return found;
    },
    ownerNameProjection: () => framework.projection,
    findOfflineByCitizenIds: async () => new Map(),
    registerUsableItem: () => {}
  },
  detectFramework: () => 'qb'
}));

// Imported for its side effect: loading the module is what registers
// `gphone:server:conversations:get`, which `call` below drives.
import '../services/Conversations';
import { deliverToParticipants } from '../services/Messages';
import { Database } from '../lib/Database';

const db = Database as unknown as CountingDatabase;

const CALLER = 'CIT_ME';
const CALLER_SOURCE = 5;

/** The qb shape, which is what `ownerNameProjection` hands the hydration on a qb server. */
const QB_PROJECTION = {
  join: 'LEFT JOIN `players` `gp_owner` ON `gp_owner`.`citizenid` = p.citizenid',
  columns:
    "JSON_UNQUOTE(JSON_EXTRACT(`gp_owner`.`charinfo`, '$.firstname')) AS firstname, " +
    "JSON_UNQUOTE(JSON_EXTRACT(`gp_owner`.`charinfo`, '$.lastname')) AS lastname, " +
    "JSON_UNQUOTE(JSON_EXTRACT(`gp_owner`.`charinfo`, '$.phone')) AS phone"
};

beforeEach(() => {
  db.reset();
  framework.online.clear();
  framework.projection = QB_PROJECTION;
  emitted.length = 0;
  __resetRateLimits();
  (globalThis as any).source = CALLER_SOURCE;
  (globalThis as any).emitNet = vi.fn((event: string, target: number) => {
    emitted.push({ event, target });
  });
});

/** Drives a registered `gphone:server:conversations:<action>` handler as the caller. */
const call = async (action: string, data: unknown) => {
  const handler = handlers.get(`gphone:server:conversations:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);
  await handler('cb-1', data);
};

/** `n` threads, as `findForCitizen`'s own SELECT would hand them back. */
const threads = (n: number) =>
  Array.from({ length: n }, (_, index) => ({
    id: index + 1,
    citizenid: CALLER,
    is_group: 0,
    name: null,
    status: 'active',
    unread_count: 0,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00'
  }));

/** Two live participants per thread — the caller, and one other person. */
const participantsOf = (n: number) =>
  Array.from({ length: n }, (_, index) => index + 1).flatMap((conversationId) => [
    {
      id: conversationId * 10,
      conversation_id: conversationId,
      citizenid: CALLER,
      role: 'admin',
      firstname: 'Me',
      lastname: 'Myself',
      phone: '5550100'
    },
    {
      id: conversationId * 10 + 1,
      conversation_id: conversationId,
      citizenid: `CIT_${conversationId}`,
      role: 'member',
      firstname: `Person${conversationId}`,
      lastname: null,
      phone: null
    }
  ]);

describe('the conversation list is two queries, whatever the list holds', () => {
  for (const n of [1, 8, 60]) {
    it(`costs exactly two statements for ${n} thread(s)`, async () => {
      db.answerQuery(threads(n), participantsOf(n));

      await call('get', {});

      expect(db.count()).toBe(2);
    });
  }

  /**
   * The pair, named. Counting to two is only meaningful if the two are the page and the
   * hydration rather than, say, the page twice.
   */
  it('spends them on one page of threads and one batched participant read', async () => {
    db.answerQuery(threads(3), participantsOf(3));

    await call('get', {});

    expect(db.statements).toHaveLength(2);
    expect(db.statements[0].sql).toContain('FROM gphone_messages_conversations c');
    expect(db.statements[1].sql).toContain('FROM `gphone_messages_participants` p');
    // One placeholder per conversation on the page, and the ids are bound, never inlined.
    expect(db.statements[1].sql).toContain('IN (?, ?, ?)');
    expect(db.statements[1].params).toEqual([1, 2, 3]);
  });

  /**
   * The hydration join is the ESX fix. `ownerNameProjection` answers `null` where there is no
   * character table to read — standalone, and a framework that has not started yet — and the
   * query has to run anyway rather than throwing or being skipped, because the participant
   * rows themselves are still needed.
   */
  it('still costs two when the framework has no character table to join', async () => {
    framework.projection = null;
    db.answerQuery(threads(4), participantsOf(4));

    await call('get', {});

    expect(db.count()).toBe(2);
    expect(db.statements[1].sql).not.toContain('LEFT JOIN');
    expect(db.statements[1].sql).toContain('NULL AS firstname');
  });

  /**
   * Nobody connected is the case that used to reach for the directory's offline lookup, which
   * would have been a third statement re-reading the very rows the join just returned. The
   * overlay is `resolveOnline` precisely so that it cannot.
   */
  it('adds no lookup for participants who are all offline', async () => {
    db.answerQuery(threads(10), participantsOf(10));

    await call('get', {});

    expect(db.count()).toBe(2);
  });

  it('adds no lookup for participants who are all online either', async () => {
    for (let index = 1; index <= 10; index++) framework.online.set(`CIT_${index}`, 100 + index);
    framework.online.set(CALLER, CALLER_SOURCE);
    db.answerQuery(threads(10), participantsOf(10));

    await call('get', {});

    expect(db.count()).toBe(2);
  });

  /** An empty list asks nothing further — there are no ids to hydrate. */
  it('costs one statement when the player has no threads at all', async () => {
    db.answerQuery([]);

    await call('get', {});

    expect(db.count()).toBe(1);
  });
});

/**
 * A group send. The row is written elsewhere; this is the fan-out, which used to walk the
 * framework once and query the blocklist once **per recipient**.
 */
describe('a group send is bounded, whatever the group holds', () => {
  const message = { id: 42, conversation_id: 7, citizenid: 'SENDER', message: 'hi' } as never;

  /** `n` other people in the thread, all of them connected. */
  const thread = (n: number) => {
    const rows = [{ citizenid: 'SENDER', status: 'active' }];
    for (let index = 1; index <= n; index++) {
      rows.push({ citizenid: `CIT_R${index}`, status: 'active' });
      framework.online.set(`CIT_R${index}`, 200 + index);
    }
    return rows;
  };

  for (const n of [1, 6, 32]) {
    it(`costs exactly two statements for ${n} recipient(s)`, async () => {
      db.answerQuery(thread(n), []);

      await deliverToParticipants(7, 'SENDER', { name: 'A B', phone: '5550100' }, message);

      // One read of the participants table, one batched blocklist read. Not one per person.
      expect(db.count()).toBe(2);
      expect(emitted).toHaveLength(n);
    });
  }

  it('spends them on the participant read and one IN blocklist read', async () => {
    db.answerQuery(thread(3), []);

    await deliverToParticipants(7, 'SENDER', { name: 'A B', phone: '5550100' }, message);

    expect(db.statements).toHaveLength(2);
    expect(db.statements[0].sql).toContain('FROM gphone_messages_participants');
    expect(db.statements[1].sql).toContain('FROM `gphone_blocklist`');
    // Every recipient in one statement, and the sender's number last.
    expect(db.statements[1].params).toEqual(['CIT_R1', 'CIT_R2', 'CIT_R3', '5550100']);
  });

  /**
   * An all-offline thread costs the participant read and nothing else. The push is withheld
   * from every one of them anyway, so a blocklist round trip on their behalf would be work
   * with no consequence attached to it.
   */
  it('costs one statement when nobody in the thread is connected', async () => {
    db.answerQuery([
      { citizenid: 'SENDER', status: 'active' },
      { citizenid: 'CIT_AWAY', status: 'active' }
    ]);

    await deliverToParticipants(7, 'SENDER', { name: 'A B', phone: '5550100' }, message);

    expect(db.count()).toBe(1);
    expect(emitted).toEqual([]);
  });
});
