// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, handlers } = vi.hoisted(() => {
  // Captured inside `vi.hoisted`, as `reports.test.ts` does: the service registers at import.
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
vi.mock('../lib/DiscordWebhook', () => ({ forwardReportFiled: vi.fn(), forwardAudit: vi.fn() }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: 'ADMIN1', source: 5, setMeta: () => {} }),
    getCitizenId: () => 'ADMIN1',
    registerUsableItem: () => {}
  }
}));

import { UNRECORDED_DEFAULT, unrecordedPriorStatus } from '../services/Reports';
// Every declarer, so the registry below is the server's whole list rather than an empty one.
import '../services/Messages';
import '../services/Media';
import '../services/Accounts';
import '../services/Blabber';
import '../services/BlabberDms';
import '../services/DarkchatMessages';
import '../services/Glimpse';
import '../services/GlimpseComments';
import '../services/Marketplace';
import { REPORTABLE } from '../lib/moderation';

/**
 * Moderate, then reopen, and the row goes back to what it was (MICA-386).
 *
 * `restoreTarget` used to write `active` whatever the row held before its takedown, so a post
 * its author had deleted — reported while live, deleted, then moderated — came back live when
 * the report was reopened. Driven through the real `resolve` and `reopen` handlers against a
 * stand-in that keeps the reported rows and `mica_reports` in memory and reads only the
 * statements those two handlers send: anything else fails the test, so a new statement is
 * seen rather than answered blindly.
 */

interface ReportRow {
  id: number;
  citizenid: string;
  target_table: string;
  target_id: number;
  category: string;
  resolution: 'pending' | 'actioned' | 'dismissed';
  target_prior_status: string | null;
  status: 'active' | 'deleted';
}

let targets: Map<string, { id: number; status: string }[]>;
let reports: ReportRow[];
/**
 * Where a test parks a statement to interleave two handlers. A read answers from the state when
 * it was asked, as the database would, and only then waits; a write waits, then applies.
 */
let hold: ((what: 'count' | 'prior' | 'record', params: unknown[]) => Promise<void> | void) | null;
let replies: Map<string, any>;
let sequence = 0;

const one = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const target = (table: string, id: number) => targets.get(table)?.find((row) => row.id === id);

const statusOf = (table: string, id: number) => target(table, id)?.status;

const othersOn = (params: unknown[]) => {
  const [table, targetId, id] = params as [string, number, number];
  return reports.filter(
    (r) =>
      r.target_table === table &&
      r.target_id === Number(targetId) &&
      r.id !== Number(id) &&
      r.resolution === 'actioned' &&
      r.status === 'active'
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  targets = new Map();
  reports = [];
  hold = null;
  replies = new Map();
  (globalThis as any).source = 5;
  // By callback id, so two handlers in flight at once each get their own reply.
  (globalThis as any).emitNet = vi.fn((...args: unknown[]) =>
    replies.set(String(args[2]), args[3])
  );
  (globalThis as any).IsPlayerAceAllowed = () => true;
  (globalThis as any).GetConvar = (_n: string, f: string) => f;

  dbMock.single.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = one(sql);
    if (text === 'SELECT * FROM `mica_reports` WHERE `id` = ?') {
      const row = reports.find((r) => r.id === Number(params[0]));
      return row ? { ...row } : null;
    }
    const read = /^SELECT `status` FROM `(\w+)` WHERE `id` = \?$/.exec(text);
    if (read) {
      const row = target(read[1], Number(params[0]));
      return row ? { status: row.status } : null;
    }
    throw new Error(`stand-in: unexpected single: ${text}`);
  });

  dbMock.update.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = one(sql);
    if (text === 'UPDATE `mica_reports` SET `resolution` = ? WHERE `id` = ? AND `resolution` = ?') {
      const [next, id, expected] = params as [ReportRow['resolution'], number, string];
      const row = reports.find((r) => r.id === Number(id) && r.resolution === expected);
      if (!row) return false;
      row.resolution = next;
      return true;
    }
    if (text === 'UPDATE `mica_reports` SET `resolution` = ? WHERE `id` = ?') {
      const [next, id] = params as [ReportRow['resolution'], number];
      const row = reports.find((r) => r.id === Number(id));
      if (!row) return false;
      row.resolution = next;
      return true;
    }
    if (text === 'UPDATE `mica_reports` SET `target_prior_status` = ? WHERE `id` = ?') {
      await hold?.('record', params);
      const [prior, id] = params as [string | null, number];
      const row = reports.find((r) => r.id === Number(id));
      if (!row) return false;
      row.target_prior_status = prior;
      return true;
    }
    const move = /^UPDATE `(\w+)` SET `status` = \? WHERE `id` = \? AND `status` = \?$/.exec(text);
    if (move) {
      const [to, id, from] = params as [string, number, string];
      const row = target(move[1], Number(id));
      if (!row || row.status !== from) return false;
      row.status = to;
      return true;
    }
    throw new Error(`stand-in: unexpected update: ${text}`);
  });

  dbMock.scalar.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = one(sql);
    const tail =
      'FROM `mica_reports` WHERE `target_table` = ? AND `target_id` = ? AND `id` <> ? ' +
      "AND `resolution` = 'actioned' AND `status` = 'active'";
    if (text === `SELECT COUNT(*) ${tail}`) {
      const count = othersOn(params).length;
      await hold?.('count', params);
      return count;
    }
    if (
      text ===
      `SELECT \`target_prior_status\` ${tail} AND \`target_prior_status\` IS NOT NULL ` +
        'ORDER BY `id` LIMIT 1'
    ) {
      const held = othersOn(params)
        .filter((r) => r.target_prior_status !== null)
        .sort((a, b) => a.id - b.id);
      await hold?.('prior', params);
      return held[0]?.target_prior_status ?? null;
    }
    throw new Error(`stand-in: unexpected scalar: ${text}`);
  });

  dbMock.insert.mockImplementation(async (sql: string) => {
    if (/mica_audit_logs/.test(sql)) return 1;
    throw new Error(`stand-in: unexpected insert: ${sql}`);
  });
  dbMock.query.mockImplementation(async (sql: string) => {
    throw new Error(`stand-in: unexpected query: ${one(sql)}`);
  });
});

const row = (table: string, id: number, status: string) => {
  if (!targets.has(table)) targets.set(table, []);
  targets.get(table)!.push({ id, status });
};

const fileReport = (id: number, table: string, targetId: number): ReportRow => {
  const report: ReportRow = {
    id,
    citizenid: 'REPORTER1',
    target_table: table,
    target_id: targetId,
    category: 'spam',
    resolution: 'pending',
    target_prior_status: null,
    status: 'active'
  };
  reports.push(report);
  return report;
};

const call = async (action: 'resolve' | 'reopen', data: unknown) => {
  const handler = handlers.get(`mica:server:reports:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);
  const cbId = `cb-${++sequence}`;
  await handler(cbId, data);
  return replies.get(cbId);
};

/**
 * Park the first statement `match` picks, start `second` while it is parked, give `second`
 * every chance to run to the end, then let the first go on. Without one decision about a row
 * at a time, `second` finishes inside the window; with it, `second` waits its turn.
 */
const interleave = async (
  match: (what: 'count' | 'prior' | 'record', params: unknown[]) => boolean,
  first: () => Promise<unknown>,
  second: () => Promise<unknown>
) => {
  let parked = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  hold = (what, params) => {
    if (parked || !match(what, params)) return;
    parked = true;
    return gate;
  };
  const running = first();
  await vi.waitFor(() => expect(parked).toBe(true));
  const racing = second();
  await new Promise((resolve) => setTimeout(resolve, 25));
  release();
  return await Promise.all([running, racing]);
};

const moderate = (id: number) => call('resolve', { id, action: 'moderate' });
const reopen = (id: number) => call('reopen', { id });

describe('a reopen puts back what the takedown replaced (MICA-386)', () => {
  it('declares the nine reportable tables this suite walks', () => {
    // A loop over an empty registry asserts nothing, so the count is the first assertion.
    expect(Object.keys(REPORTABLE()).sort()).toEqual([
      'mica_accounts',
      'mica_blabber',
      'mica_blabber_dms',
      'mica_darkchat_messages',
      'mica_glimpse',
      'mica_glimpse_comments',
      'mica_marketplace',
      'mica_media',
      'mica_messages'
    ]);
  });

  it.each(Object.keys(REPORTABLE()))(
    'keeps a row of %s its author deleted deleted through moderate and reopen',
    async (table) => {
      row(table, 40, 'active');
      fileReport(1, table, 40);
      // The author deletes after the report is filed, before an admin reaches the queue.
      target(table, 40)!.status = 'deleted';

      expect(await moderate(1)).toMatchObject({ ok: true, resolution: 'actioned' });
      expect(statusOf(table, 40)).toBe('moderated');
      expect(reports[0].target_prior_status).toBe('deleted');

      expect(await reopen(1)).toMatchObject({ ok: true, resolution: 'pending' });
      expect(statusOf(table, 40)).toBe('deleted');
    }
  );

  it.each(Object.keys(REPORTABLE()))(
    'puts a live row of %s back live — the positive twin',
    async (table) => {
      row(table, 40, 'active');
      fileReport(1, table, 40);

      await moderate(1);
      expect(statusOf(table, 40)).toBe('moderated');
      expect(reports[0].target_prior_status).toBe('active');

      await reopen(1);
      expect(statusOf(table, 40)).toBe('active');
    }
  );

  it('puts a listing sold before its takedown back to sold, not up for sale', async () => {
    row('mica_marketplace', 40, 'sold');
    fileReport(1, 'mica_marketplace', 40);

    await moderate(1);
    await reopen(1);
    expect(statusOf('mica_marketplace', 40)).toBe('sold');
  });

  it('records each cycle afresh, so a delete between two cycles is honoured', async () => {
    row('mica_blabber', 40, 'active');
    fileReport(1, 'mica_blabber', 40);

    await moderate(1);
    await reopen(1);
    expect(statusOf('mica_blabber', 40)).toBe('active');

    target('mica_blabber', 40)!.status = 'deleted';
    await moderate(1);
    expect(reports[0].target_prior_status).toBe('deleted');
    await reopen(1);
    expect(statusOf('mica_blabber', 40)).toBe('deleted');
  });

  it('records "gone" over a previous cycle when the row has disappeared', async () => {
    row('mica_blabber', 40, 'active');
    fileReport(1, 'mica_blabber', 40);
    await moderate(1);
    await reopen(1);
    expect(reports[0].target_prior_status).toBe('active');

    targets.set('mica_blabber', []);
    expect(await moderate(1)).toMatchObject({ ok: true, resolution: 'actioned' });
    expect(reports[0].target_prior_status).toBeNull();
  });
});

describe('several reports of one row (MICA-386)', () => {
  it('a second takedown inherits what the first replaced, not `moderated`', async () => {
    row('mica_blabber', 40, 'deleted');
    fileReport(1, 'mica_blabber', 40);
    fileReport(2, 'mica_blabber', 40);

    await moderate(1);
    await moderate(2);
    expect(reports.map((r) => r.target_prior_status)).toEqual(['deleted', 'deleted']);
  });

  it('reopening one leaves the row down while the other takedown stands', async () => {
    row('mica_blabber', 40, 'active');
    fileReport(1, 'mica_blabber', 40);
    fileReport(2, 'mica_blabber', 40);
    await moderate(1);
    await moderate(2);

    expect(await reopen(1)).toMatchObject({ ok: true, resolution: 'pending' });
    expect(statusOf('mica_blabber', 40)).toBe('moderated');

    // The last one out restores the status from before either.
    await reopen(2);
    expect(statusOf('mica_blabber', 40)).toBe('active');
  });

  it('restores the same status whichever report is reopened last', async () => {
    row('mica_blabber', 40, 'deleted');
    fileReport(1, 'mica_blabber', 40);
    fileReport(2, 'mica_blabber', 40);
    await moderate(1);
    await moderate(2);

    await reopen(2);
    expect(statusOf('mica_blabber', 40)).toBe('moderated');
    await reopen(1);
    expect(statusOf('mica_blabber', 40)).toBe('deleted');
  });

  it('a dismissed report of the same row holds nothing down', async () => {
    row('mica_blabber', 40, 'active');
    fileReport(1, 'mica_blabber', 40);
    fileReport(2, 'mica_blabber', 40);
    await moderate(1);
    expect(await call('resolve', { id: 2, action: 'dismiss' })).toMatchObject({
      resolution: 'dismissed'
    });

    await reopen(1);
    expect(statusOf('mica_blabber', 40)).toBe('active');
  });
});

describe('two decisions about one row at once (MICA-386 review)', () => {
  it('a takedown racing the reopen of another report leaves the row down', async () => {
    // Reopen 1 has claimed and asked whether another takedown holds the row — report 2 is
    // still pending, so no — when report 2 is moderated. Report 2 found the row moderated,
    // wrote nothing, and the reopen then put it live under an actioned report.
    row('mica_blabber', 40, 'active');
    fileReport(1, 'mica_blabber', 40);
    fileReport(2, 'mica_blabber', 40);
    await moderate(1);

    const [reopened, resolved] = await interleave(
      (what, params) => what === 'count' && Number(params[2]) === 1,
      () => reopen(1),
      () => moderate(2)
    );

    expect(reopened).toMatchObject({ ok: true, resolution: 'pending' });
    expect(resolved).toMatchObject({ ok: true, resolution: 'actioned' });
    expect(statusOf('mica_blabber', 40)).toBe('moderated');
    expect(reports[1].target_prior_status).toBe('active');

    // And the one report still actioned puts it back.
    await reopen(2);
    expect(statusOf('mica_blabber', 40)).toBe('active');
  });

  it('two takedowns of one live row at once both record what it was', async () => {
    // Takedown 1 has moved the row but not yet recorded `active` when takedown 2 reads it
    // moderated and asks for the record it should inherit: there was none yet.
    row('mica_blabber', 40, 'active');
    fileReport(1, 'mica_blabber', 40);
    fileReport(2, 'mica_blabber', 40);

    const outcomes = await interleave(
      (what, params) => what === 'record' && Number(params[1]) === 1,
      () => moderate(1),
      () => moderate(2)
    );

    expect(outcomes).toMatchObject([{ ok: true }, { ok: true }]);
    expect(reports.map((r) => r.target_prior_status)).toEqual(['active', 'active']);

    await reopen(1);
    await reopen(2);
    expect(statusOf('mica_blabber', 40)).toBe('active');
  });

  it('a decision that fails lets the next one about the row run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    row('mica_blabber', 40, 'active');
    fileReport(1, 'mica_blabber', 40);
    fileReport(2, 'mica_blabber', 40);
    const stand = dbMock.update.getMockImplementation()!;
    dbMock.update.mockImplementationOnce(stand).mockImplementationOnce(async () => {
      throw new Error('takedown exploded');
    });

    // Claim, then a takedown that throws: released, and the claim put back.
    expect((await moderate(1)).error).toBeTruthy();
    expect(reports[0].resolution).toBe('pending');
    expect(await moderate(2)).toMatchObject({ ok: true, resolution: 'actioned' });
    expect(statusOf('mica_blabber', 40)).toBe('moderated');
  });
});

describe('a takedown with no record of what it replaced (MICA-386)', () => {
  /**
   * What each table's author can do to a row decides the guess. Accounts and DMs have no
   * delete at all, so `active` is all a takedown can have replaced — and `deleted` would lose an
   * account's handle for good. A listing is never `deleted`; `removed` is its seller's own.
   */
  const FALLBACK: Record<string, string> = {
    mica_accounts: 'active',
    mica_blabber_dms: 'active',
    // A Dark Chat message leaves only by its window, a hard delete (MICA-254).
    mica_darkchat_messages: 'active',
    mica_marketplace: 'removed',
    mica_blabber: 'deleted',
    mica_glimpse: 'deleted',
    mica_glimpse_comments: 'deleted',
    mica_messages: 'deleted',
    mica_media: 'deleted'
  };

  it('decides a fallback for every reportable table, and defaults the rest closed', () => {
    expect(Object.keys(FALLBACK).sort()).toEqual(Object.keys(REPORTABLE()).sort());
    for (const [table, status] of Object.entries(FALLBACK)) {
      expect(unrecordedPriorStatus(table), table).toBe(status);
    }
    expect(unrecordedPriorStatus('mica_some_addon')).toBe(UNRECORDED_DEFAULT);
    expect(UNRECORDED_DEFAULT).toBe('deleted');
  });

  it.each(Object.entries(FALLBACK))(
    'reopens a %s row moderated before the record to %s',
    async (table, status) => {
      // What a report actioned before MICA-386 looks like: moderated, and nothing recorded.
      row(table, 40, 'moderated');
      fileReport(1, table, 40).resolution = 'actioned';

      expect(await reopen(1)).toMatchObject({ ok: true, resolution: 'pending' });
      expect(statusOf(table, 40)).toBe(status);
    }
  );

  it('restores what a takedown recorded, never the fallback, once there is a record', async () => {
    // The positive twin: an account with a record of `active` and one with no record agree,
    // so pin a table whose fallback differs from what was recorded.
    row('mica_marketplace', 40, 'active');
    fileReport(1, 'mica_marketplace', 40);
    await moderate(1);
    await reopen(1);
    expect(statusOf('mica_marketplace', 40)).toBe('active');
  });

  it('a second takedown over an unrecorded one records nothing either', async () => {
    row('mica_blabber', 40, 'moderated');
    fileReport(1, 'mica_blabber', 40).resolution = 'actioned';
    fileReport(2, 'mica_blabber', 40);

    await moderate(2);
    expect(reports[1].target_prior_status).toBeNull();
  });

  it('still answers the admin, and keeps the takedown, when the record fails to write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    row('mica_blabber', 40, 'active');
    fileReport(1, 'mica_blabber', 40);
    const stand = dbMock.update.getMockImplementation()!;
    dbMock.update.mockImplementation(async (sql: string, params: unknown[]) => {
      if (/`target_prior_status` = \?/.test(sql)) {
        throw new Error(
          'mica was unable to execute a query!\nUPDATE …\n["active",1]\nLost connection'
        );
      }
      return stand(sql, params);
    });

    expect(await moderate(1)).toMatchObject({ ok: true, resolution: 'actioned' });
    expect(statusOf('mica_blabber', 40)).toBe('moderated');
    expect(reports[0].resolution).toBe('actioned');
    // The driver's last line, not the statement and its parameters.
    const logged = (console.error as any).mock.calls.flat().join('\n');
    expect(logged).toContain('Lost connection');
    expect(logged).not.toContain('["active",1]');
  });

  it('leaves a row something else has moved since its takedown alone', async () => {
    row('mica_blabber', 40, 'active');
    fileReport(1, 'mica_blabber', 40);
    await moderate(1);
    target('mica_blabber', 40)!.status = 'deleted';

    expect(await reopen(1)).toMatchObject({ ok: true, resolution: 'pending' });
    expect(statusOf('mica_blabber', 40)).toBe('deleted');
  });
});
