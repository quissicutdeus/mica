// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, handlers } = vi.hoisted(() => {
  /**
   * Capture every server event so the handlers can be driven directly.
   *
   * Inside `vi.hoisted` because ESM evaluates imports before any module-level
   * statement — assigning `onNet` further down would run *after* the controller
   * imported and capture nothing, which reads as "no handler" rather than as a broken
   * test.
   */
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

/** `ServiceEndpoint` resolves the caller's citizenid through the bridge before dispatching. */
const bridge = vi.hoisted(() => ({ current: 'REPORTER1' }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.current, source: 5, setMeta: () => {} }),
    getCitizenId: () => bridge.current,
    registerUsableItem: () => {}
  }
}));

import '../services/Reports';
/**
 * Imported for their side effect: a service declares itself reportable through
 * `defineService`, so nothing is on the allowlist until the service that owns the table
 * has loaded. In the server that is guaranteed by `services/index.ts`; here it has to be
 * explicit, which is the honest shape — the registry really is populated by import.
 */
import '../services/Messages';
import '../services/Media';
import '../services/Accounts';
import '../services/Blabber';
import '../services/BlabberDms';
import { isReportableTable, isReportCategory, REPORTABLE } from '../lib/moderation';

const REPORTER = 'REPORTER1';
const ADMIN = 'ADMIN1';
const SRC = 5;

/**
 * Drive a registered handler the way `ServiceEndpoint` does, and surface what it returned or
 * threw. The reply crosses NUI as `emitNet`, so the assertions read that.
 */
const call = async (action: string, data: unknown, citizenid = REPORTER) => {
  const handler = handlers.get(`gos:server:reports:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);

  bridge.current = citizenid;
  (globalThis as any).source = SRC;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  const reply = (globalThis.emitNet as any).mock.calls[0]?.[3];
  return reply;
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(1);
  dbMock.update.mockResolvedValue(true);
  dbMock.single.mockResolvedValue(null);
  (globalThis as any).IsPlayerAceAllowed = () => false;
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
});

describe('reportable allowlist', () => {
  it('accepts only the declared tables', () => {
    // `target_table` arrives in a NUI payload and is interpolated into SQL, because
    // MySQL cannot parameterise an identifier. The allowlist is the only thing making
    // that safe.
    expect(isReportableTable('gos_messages')).toBe(true);
    expect(isReportableTable('gos_media')).toBe(true);

    // The social surfaces, which could not be reported at all before. Blabber is public,
    // its DMs let a stranger reach you, and an account carries the handle and bio a player
    // judges somebody by — and Blabber has honoured `moderated` defensively since it
    // shipped, on rows that could never acquire the status.
    expect(isReportableTable('gos_blabber')).toBe(true);
    expect(isReportableTable('gos_blabber_dms')).toBe(true);
    expect(isReportableTable('gos_accounts')).toBe(true);

    // And the old name is gone rather than kept "for compatibility". The allowlist is a
    // security boundary — `target_table` is interpolated into SQL because MySQL cannot
    // parameterise an identifier (§2.9) — so a stale entry is a second accepted name for
    // one table, and the migration rewrites existing rows to the new one.
    expect(isReportableTable('gos_photos')).toBe(false);
    for (const bad of ['players', 'gos_notes', 'gos_messages; DROP TABLE x', '', null, 7]) {
      expect(isReportableTable(bad), String(bad)).toBe(false);
    }
  });

  it('does not treat inherited Object properties as tables', () => {
    // A plain `in` or property lookup would say yes to these.
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(isReportableTable(bad), bad).toBe(false);
    }
  });

  it('every reportable table declares how to preview it', () => {
    for (const [table, meta] of Object.entries(REPORTABLE)) {
      expect(meta.previewColumn, table).toBeTruthy();
      expect(meta.label, table).toBeTruthy();
    }
  });

  it('accepts only declared categories', () => {
    expect(isReportCategory('harassment')).toBe(true);
    expect(isReportCategory('nonsense')).toBe(false);
    expect(isReportCategory(undefined)).toBe(false);
  });
});

describe('filing a report', () => {
  const targetRow = { citizenid: 'AUTHOR1', status: 'active', preview: 'hello there' };

  it('records the report against the content', async () => {
    dbMock.single.mockResolvedValue(targetRow);

    const reply = await call('create', {
      targetTable: 'gos_messages',
      targetId: 12,
      category: 'harassment',
      note: 'rude'
    });

    expect(reply).toMatchObject({ ok: true });
    const [sql, params] = dbMock.insert.mock.calls[0];
    expect(sql).toContain('INSERT INTO `gos_reports`');
    expect(params).toEqual(expect.arrayContaining([REPORTER, 'gos_messages', 12, 'harassment']));
  });

  it('refuses a table that is not reportable', async () => {
    const reply = await call('create', { targetTable: 'players', targetId: 1 });
    expect(reply).toMatchObject({ error: expect.stringMatching(/cannot be reported/i) });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses content that no longer exists', async () => {
    dbMock.single.mockResolvedValue(null);
    const reply = await call('create', { targetTable: 'gos_media', targetId: 3 });
    expect(reply).toMatchObject({ error: expect.stringMatching(/no longer exists/i) });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a player reporting their own content', async () => {
    // Otherwise the queue fills with self-reports nobody can act on.
    dbMock.single.mockResolvedValue({ ...targetRow, citizenid: REPORTER });
    const reply = await call('create', { targetTable: 'gos_messages', targetId: 12 });
    expect(reply).toMatchObject({ error: expect.stringMatching(/your own content/i) });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('falls back to `other` rather than storing an invented category', async () => {
    dbMock.single.mockResolvedValue(targetRow);
    await call('create', {
      targetTable: 'gos_messages',
      targetId: 12,
      category: '<script>alert(1)</script>'
    });
    expect(dbMock.insert.mock.calls[0][1]).toEqual(expect.arrayContaining(['other']));
  });

  it('refuses an oversized note rather than capping it', async () => {
    // It used to `slice(0, 500)`, so an admin read a report whose text stopped mid-sentence
    // and the reporter was told it had been filed as written. `gos_reports.note` is a
    // varchar(500) and the contract says so.
    dbMock.single.mockResolvedValue(targetRow);

    const reply = await call('create', {
      targetTable: 'gos_messages',
      targetId: 12,
      note: 'x'.repeat(5000)
    });

    expect(reply).toMatchObject({ error: expect.stringContaining('note') });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('rejects a non-scalar target id', async () => {
    dbMock.single.mockResolvedValue(targetRow);
    const reply = await call('create', { targetTable: 'gos_messages', targetId: [12] });
    expect(reply).toMatchObject({ error: expect.any(String) });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

describe('the queue is admin-only', () => {
  it('refuses a player', async () => {
    const reply = await call('queue', {});
    expect(reply).toMatchObject({ error: expect.stringMatching(/not authorised/i) });
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('serves an admin, oldest first', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.query.mockResolvedValue([
      { id: 2, created_at: '2026-02-01T00:00:00Z', resolution: 'pending' },
      { id: 1, created_at: '2026-01-01T00:00:00Z', resolution: 'pending' }
    ]);

    const reply = await call('queue', {}, ADMIN);
    // A queue that surfaces the newest first starves the backlog.
    expect(reply.map((r: any) => r.id)).toEqual([1, 2]);
  });
});

/**
 * MICA-70. `AuditLogger` recorded a moderation decision from the day it shipped and
 * nothing else — an admin reading twenty reported messages left no trace, decided or not.
 * `queue` and `history` are where reported content first reaches an admin's screen, so
 * that is where the read gets logged.
 */
describe('viewing the queue and history is audited', () => {
  /** Every audit-ledger insert, decoded into the columns `AuditLogger.log` wrote. */
  const auditEntries = () =>
    dbMock.insert.mock.calls
      .filter(([sql]) => typeof sql === 'string' && sql.includes('gos_audit_logs'))
      .map(([, params]) => {
        const [citizenid, action, service, method, targetId, targetTable, details] =
          params as unknown[];
        return {
          citizenid,
          action,
          service,
          method,
          targetId,
          targetTable,
          details: typeof details === 'string' ? JSON.parse(details) : details
        };
      });

  it('logs one viewed entry per report an admin actually sees in the queue', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.query.mockResolvedValue([
      {
        id: 9,
        created_at: '2026-01-01T00:00:00Z',
        resolution: 'pending',
        target_table: 'gos_messages',
        target_id: 4
      },
      {
        id: 10,
        created_at: '2026-01-02T00:00:00Z',
        resolution: 'pending',
        target_table: 'gos_media',
        target_id: 7
      }
    ]);

    await call('queue', {}, ADMIN);

    expect(auditEntries()).toEqual([
      {
        citizenid: ADMIN,
        action: 'viewed',
        service: 'reports',
        method: 'queue',
        targetId: 4,
        targetTable: 'gos_messages',
        details: { reportId: 9 }
      },
      {
        citizenid: ADMIN,
        action: 'viewed',
        service: 'reports',
        method: 'queue',
        targetId: 7,
        targetTable: 'gos_media',
        details: { reportId: 10 }
      }
    ]);
  });

  it('logs nothing when the queue is empty — nothing was actually shown', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.query.mockResolvedValue([]);

    await call('queue', {}, ADMIN);

    expect(auditEntries()).toEqual([]);
  });

  it('logs nothing when a player is refused before ever reaching the content', async () => {
    dbMock.query.mockResolvedValue([
      { id: 9, target_table: 'gos_messages', target_id: 4, resolution: 'pending' }
    ]);

    await call('queue', {});

    expect(auditEntries()).toEqual([]);
  });

  it('logs history views under method "history", distinct from the queue', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.query.mockResolvedValue([
      {
        id: 11,
        updated_at: '2026-01-03T00:00:00Z',
        resolution: 'actioned',
        target_table: 'gos_blabber',
        target_id: 2
      }
    ]);

    await call('history', {}, ADMIN);

    expect(auditEntries()).toEqual([
      {
        citizenid: ADMIN,
        action: 'viewed',
        service: 'reports',
        method: 'history',
        targetId: 2,
        targetTable: 'gos_blabber',
        details: { reportId: 11 }
      }
    ]);
  });
});

describe('resolving is admin-only', () => {
  const pending = {
    id: 9,
    resolution: 'pending',
    target_table: 'gos_messages',
    target_id: 4,
    category: 'spam'
  };

  it('refuses a player, and changes nothing', async () => {
    dbMock.single.mockResolvedValue(pending);
    const reply = await call('resolve', { id: 9, action: 'moderate' });

    expect(reply).toMatchObject({ error: expect.stringMatching(/not authorised/i) });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('moderating hides the content and records who did it', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue(pending);

    const reply = await call('resolve', { id: 9, action: 'moderate' }, ADMIN);
    expect(reply).toMatchObject({ ok: true, resolution: 'actioned' });

    // Soft status change, not a delete: the audit trail has to keep pointing at a row.
    // The status is bound rather than interpolated, so this reads the parameters.
    const hide = dbMock.update.mock.calls.find((c: any[]) => /UPDATE `gos_messages`/.test(c[0]));
    expect(hide, 'the content should be hidden').toBeTruthy();
    expect(hide[0]).not.toMatch(/DELETE/i);
    expect(hide[1]).toEqual(expect.arrayContaining(['moderated']));

    const statements = dbMock.update.mock.calls.map((c: any[]) => c[0]);
    expect(statements.some((s: string) => /UPDATE `gos_reports`/.test(s))).toBe(true);

    const audited = dbMock.insert.mock.calls.some((c: any[]) => /gos_audit_logs/.test(c[0]));
    expect(audited, 'moderation must be recorded in the ledger').toBe(true);
  });

  it('dismissing leaves the content alone', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue(pending);

    const reply = await call('resolve', { id: 9, action: 'dismiss' }, ADMIN);
    expect(reply).toMatchObject({ resolution: 'dismissed' });

    const statements = dbMock.update.mock.calls.map((c: any[]) => c[0]);
    expect(statements.some((s: string) => /gos_messages/.test(s))).toBe(false);
  });

  it('refuses to resolve the same report twice', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue({ ...pending, resolution: 'actioned' });

    const reply = await call('resolve', { id: 9, action: 'moderate' }, ADMIN);
    expect(reply).toMatchObject({ error: expect.stringMatching(/already resolved/i) });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  /**
   * MICA-132. `findById`, a JavaScript check that `resolution === 'pending'`, then
   * `moderateTarget` *and then* `repo.resolve` — so two admins hitting Resolve on the same
   * queue entry both passed the check and both took the content down, leaving two audit
   * entries for one decision. Admin-gated, so this is ledger integrity rather than an
   * attack, but a double-counting ledger is the thing a ledger exists to prevent.
   *
   * Adding a predicate to the final `resolve` would not have been enough: the moderation
   * ran *before* it. The order is inverted — claim the row, then act on what it points at.
   */
  it('claims the report before moderating, so the write decides and not the read', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue(pending);

    await call('resolve', { id: 9, action: 'moderate' }, ADMIN);

    const claimIndex = dbMock.update.mock.calls.findIndex((c: any[]) =>
      /UPDATE `gos_reports`/.test(c[0])
    );
    const moderateIndex = dbMock.update.mock.calls.findIndex((c: any[]) =>
      /UPDATE `gos_messages`/.test(c[0])
    );
    expect(claimIndex).toBeGreaterThanOrEqual(0);
    expect(moderateIndex).toBeGreaterThan(claimIndex);

    // The claim carries the resolution it expects to find, which is what makes it a claim
    // rather than a blind write. A stub cannot enforce that, so the statement is asserted.
    const claim = dbMock.update.mock.calls[claimIndex];
    expect(String(claim[0])).toContain('`resolution` = ?');
    expect(String(claim[0])).toContain('`id` = ? AND `resolution` = ?');
    expect(claim[1]).toEqual(['actioned', 9, 'pending']);
  });

  it('moderates nothing when a concurrent admin claimed the report first', async () => {
    // The read still says pending — this is the interleaving. The claim matching no row is
    // how the database says somebody else got there.
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue(pending);
    dbMock.update.mockResolvedValue(false);

    const reply = await call('resolve', { id: 9, action: 'moderate' }, ADMIN);

    expect(reply).toMatchObject({ error: expect.stringMatching(/already resolved/i) });
    const moderated = dbMock.update.mock.calls.some((c: any[]) =>
      /UPDATE `gos_messages`/.test(c[0])
    );
    expect(moderated, 'the loser must not take the content down too').toBe(false);
  });

  it('lets only one of two overlapping resolves moderate the target', async () => {
    // Both admins read `pending` before either wrote — the shape the JavaScript check could
    // never decide. Driven against one stub and released out of order.
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue(pending);

    let claimed = false;
    const gate: (() => void)[] = [];
    dbMock.update.mockImplementation(async (sql: string) => {
      if (!/UPDATE `gos_reports`/.test(sql)) return true;
      await new Promise<void>((resolve) => gate.push(resolve));
      if (claimed) return false;
      claimed = true;
      return true;
    });

    const replies = new Map<string, any>();
    bridge.current = ADMIN;
    (globalThis as any).source = SRC;
    (globalThis as any).emitNet = vi.fn((...args: any[]) => replies.set(String(args[2]), args[3]));
    const handler = handlers.get('gos:server:reports:resolve')!;
    const running = Promise.all([
      handler('cb-first', { id: 9, action: 'moderate' }),
      handler('cb-second', { id: 9, action: 'moderate' })
    ]);

    await vi.waitFor(() => expect(gate).toHaveLength(2));
    gate.pop()!();
    gate.pop()!();
    await running;

    const outcomes = [replies.get('cb-first'), replies.get('cb-second')];
    expect(outcomes.filter((reply) => reply?.ok === true)).toHaveLength(1);
    expect(outcomes.filter((reply) => /already resolved/i.test(reply?.error ?? ''))).toHaveLength(
      1
    );
    // One decision, one takedown.
    const takedowns = dbMock.update.mock.calls.filter((c: any[]) =>
      /UPDATE `gos_messages`/.test(c[0])
    );
    expect(takedowns).toHaveLength(1);
  });

  it('releases the claim when the takedown itself fails', async () => {
    // The claim has committed by then, so leaving it would mark a report actioned over
    // content that is still up — the compensating path `Hodlr` sell has always had.
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue(pending);
    dbMock.update.mockImplementation(async (sql: string) => {
      if (/UPDATE `gos_messages`/.test(sql)) throw new Error('takedown exploded');
      return true;
    });

    const reply = await call('resolve', { id: 9, action: 'moderate' }, ADMIN);

    expect(reply.error).toBeTruthy();
    const reportWrites = dbMock.update.mock.calls.filter((c: any[]) =>
      /UPDATE `gos_reports`/.test(c[0])
    );
    // Claimed, then put back to pending so the queue still shows the work as undone.
    expect(reportWrites).toHaveLength(2);
    expect(reportWrites[1][1]).toEqual(expect.arrayContaining(['pending']));
  });

  it('refuses a report pointing at a table no longer reportable', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue({ ...pending, target_table: 'players' });

    const reply = await call('resolve', { id: 9, action: 'moderate' }, ADMIN);
    expect(reply).toMatchObject({ error: expect.any(String) });
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});

describe('history and undo', () => {
  const actioned = {
    id: 9,
    resolution: 'actioned',
    target_table: 'gos_messages',
    target_id: 4,
    category: 'spam'
  };

  it('history is admin-only', async () => {
    const reply = await call('history', {});
    expect(reply).toMatchObject({ error: expect.stringMatching(/not authorised/i) });
  });

  it('reopening is admin-only, and changes nothing', async () => {
    dbMock.single.mockResolvedValue(actioned);
    const reply = await call('reopen', { id: 9 });

    expect(reply).toMatchObject({ error: expect.stringMatching(/not authorised/i) });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('undoing a removal puts the content back', async () => {
    // Undo that cleared the decision but left the content hidden would be worse than no
    // undo at all.
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue(actioned);

    const reply = await call('reopen', { id: 9 }, ADMIN);
    expect(reply).toMatchObject({ ok: true, resolution: 'pending' });

    const statements = dbMock.update.mock.calls;
    const restore = statements.find((c: any[]) => /UPDATE `gos_messages`/.test(c[0]));
    expect(restore, 'the content should be restored').toBeTruthy();
    expect(restore[1]).toEqual(expect.arrayContaining(['active']));
  });

  it('undoing a dismissal leaves content alone — it was never hidden', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue({ ...actioned, resolution: 'dismissed' });

    await call('reopen', { id: 9 }, ADMIN);
    const touched = dbMock.update.mock.calls.some((c: any[]) => /gos_messages/.test(c[0]));
    expect(touched).toBe(false);
  });

  it('refuses to reopen something already open', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue({ ...actioned, resolution: 'pending' });

    const reply = await call('reopen', { id: 9 }, ADMIN);
    expect(reply).toMatchObject({ error: expect.stringMatching(/already open/i) });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('records the reversal in the ledger as its own act', async () => {
    // Not `unarchived` or a second `moderated`: the ledger should read honestly.
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue(actioned);

    await call('reopen', { id: 9 }, ADMIN);
    const audit = dbMock.insert.mock.calls.find((c: any[]) => /gos_audit_logs/.test(c[0]));
    expect(audit[1]).toEqual(expect.arrayContaining(['unmoderated']));
  });
});
