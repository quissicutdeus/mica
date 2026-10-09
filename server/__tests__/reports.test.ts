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
const forwardReportFiled = vi.hoisted(() => vi.fn());
vi.mock('../lib/DiscordWebhook', () => ({ forwardReportFiled, forwardAudit: vi.fn() }));

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
import '../services/Marketplace';
import { isReportableTable, isReportCategory, REPORTABLE } from '../lib/moderation';

const REPORTER = 'REPORTER1';
const ADMIN = 'ADMIN1';
const SRC = 5;

/**
 * Drive a registered handler the way `ServiceEndpoint` does, and surface what it returned or
 * threw. The reply crosses NUI as `emitNet`, so the assertions read that.
 */
const call = async (action: string, data: unknown, citizenid = REPORTER) => {
  const handler = handlers.get(`mica:server:reports:${action}`);
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
    expect(isReportableTable('mica_messages')).toBe(true);
    expect(isReportableTable('mica_media')).toBe(true);

    // The social surfaces, which could not be reported at all before. Blabber is public,
    // its DMs let a stranger reach you, and an account carries the handle and bio a player
    // judges somebody by — and Blabber has honoured `moderated` defensively since it
    // shipped, on rows that could never acquire the status.
    expect(isReportableTable('mica_blabber')).toBe(true);
    expect(isReportableTable('mica_blabber_dms')).toBe(true);
    expect(isReportableTable('mica_accounts')).toBe(true);

    // And the old name is gone rather than kept "for compatibility". The allowlist is a
    // security boundary — `target_table` is interpolated into SQL because MySQL cannot
    // parameterise an identifier (§2.9) — so a stale entry is a second accepted name for
    // one table, and the migration rewrites existing rows to the new one.
    expect(isReportableTable('mica_photos')).toBe(false);
    for (const bad of ['players', 'mica_notes', 'mica_messages; DROP TABLE x', '', null, 7]) {
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
    // `REPORTABLE` is a function: `Object.entries` of the function itself is empty, which made
    // this loop assert nothing at all.
    const declared = Object.entries(REPORTABLE());
    expect(declared.length).toBeGreaterThan(0);
    for (const [table, meta] of declared) {
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
      targetTable: 'mica_messages',
      targetId: 12,
      category: 'harassment',
      note: 'rude'
    });

    expect(reply).toMatchObject({ ok: true });
    const [sql, params] = dbMock.insert.mock.calls[0];
    expect(sql).toContain('INSERT INTO `mica_reports`');
    expect(params).toEqual(expect.arrayContaining([REPORTER, 'mica_messages', 12, 'harassment']));
  });

  it('tells the Discord mirror once the row is written (MICA-242)', async () => {
    forwardReportFiled.mockClear();
    dbMock.single.mockResolvedValue(targetRow);

    const reply = await call('create', {
      targetTable: 'mica_messages',
      targetId: 12,
      category: 'harassment',
      note: 'rude'
    });

    expect(forwardReportFiled).toHaveBeenCalledWith({
      reportId: reply.id,
      citizenid: REPORTER,
      targetTable: 'mica_messages',
      targetId: 12,
      category: 'harassment',
      note: 'rude'
    });
  });

  it('does not tell the mirror about a filing that was refused', async () => {
    forwardReportFiled.mockClear();
    await call('create', { targetTable: 'players', targetId: 1 });
    expect(forwardReportFiled).not.toHaveBeenCalled();
  });

  it('refuses a table that is not reportable', async () => {
    const reply = await call('create', { targetTable: 'players', targetId: 1 });
    expect(reply).toMatchObject({ error: expect.stringMatching(/cannot be reported/i) });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses content that no longer exists', async () => {
    dbMock.single.mockResolvedValue(null);
    const reply = await call('create', { targetTable: 'mica_media', targetId: 3 });
    expect(reply).toMatchObject({ error: expect.stringMatching(/no longer exists/i) });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a player reporting their own content', async () => {
    // Otherwise the queue fills with self-reports nobody can act on.
    dbMock.single.mockResolvedValue({ ...targetRow, citizenid: REPORTER });
    const reply = await call('create', { targetTable: 'mica_messages', targetId: 12 });
    expect(reply).toMatchObject({ error: expect.stringMatching(/your own content/i) });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('falls back to `other` rather than storing an invented category', async () => {
    dbMock.single.mockResolvedValue(targetRow);
    await call('create', {
      targetTable: 'mica_messages',
      targetId: 12,
      category: '<script>alert(1)</script>'
    });
    expect(dbMock.insert.mock.calls[0][1]).toEqual(expect.arrayContaining(['other']));
  });

  it('refuses an oversized note rather than capping it', async () => {
    // It used to `slice(0, 500)`, so an admin read a report whose text stopped mid-sentence
    // and the reporter was told it had been filed as written. `mica_reports.note` is a
    // varchar(500) and the contract says so.
    dbMock.single.mockResolvedValue(targetRow);

    const reply = await call('create', {
      targetTable: 'mica_messages',
      targetId: 12,
      note: 'x'.repeat(5000)
    });

    expect(reply).toMatchObject({ error: expect.stringContaining('note') });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('rejects a non-scalar target id', async () => {
    dbMock.single.mockResolvedValue(targetRow);
    const reply = await call('create', { targetTable: 'mica_messages', targetId: [12] });
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
 * MICA-339 (F1/F14). `targetTable`/`targetId` are the payload's, and `summariseTarget` read the
 * row by id alone and opened its sealed body into the report. Every report now asks first
 * whether the reporter can see the row, the way that table's own reads would.
 *
 * The reads are answered from a small world by what each one asks, honouring the predicates
 * its SQL carries, so a rule that drops one — the status, the membership, the account — reaches
 * the row it would then have reached.
 */
describe('a report is only of something the reporter can see', () => {
  type Row = Record<string, unknown> & { id: number; citizenid: string; status: string };
  interface World {
    rows?: Record<string, Row[]>;
    /** `[conversation_id, citizenid]` pairs with `left_at` null. */
    members?: [number, string][];
    accounts?: { id: number; citizenid: string; status: string }[];
    messageAttachments?: { message_id: number; photo_id: number }[];
    blabAttachments?: { blab_id: number; media_id: number }[];
    listingAttachments?: { listing_id: number; media_id: number }[];
  }

  const activeIn = (sql: string, alias = '') =>
    sql.includes(`${alias}\`status\` = 'active'`)
      ? (row?: Row) => row?.status === 'active'
      : () => true;

  const world = (w: World) => {
    const rows = w.rows ?? {};
    const find = (table: string, id: unknown) => (rows[table] ?? []).find((r) => r.id === id);
    const members = w.members ?? [];
    const accounts = w.accounts ?? [];

    dbMock.single.mockImplementation(async (sql: string, params: unknown[]) => {
      // `summariseTarget`'s read: what the report would copy.
      const summary = /FROM `(\w+)` WHERE `id` = \?/.exec(sql);
      if (sql.includes('AS preview') && summary) {
        const row = find(summary[1], params[0]);
        return row ? { citizenid: row.citizenid, status: row.status, preview: row.preview } : null;
      }
      if (sql.includes('FROM `mica_messages_participants`')) {
        const [conversation, citizenid] = params;
        return members.some(([c, who]) => c === conversation && who === citizenid)
          ? { 1: 1 }
          : null;
      }
      if (sql.includes('FROM `mica_media` x')) {
        const [id, citizenid] = params;
        const photo = find('mica_media', id);
        if (!photo) return null;
        if (/x\.`status` <> 'moderated'/.test(sql) && photo.status === 'moderated') return null;
        const own = photo.citizenid === citizenid;
        const blab = (w.blabAttachments ?? []).some(
          (a) => a.media_id === id && activeIn(sql, 'b.')(find('mica_blabber', a.blab_id))
        );
        const listing = (w.listingAttachments ?? []).some(
          (a) => a.media_id === id && activeIn(sql, 'l.')(find('mica_marketplace', a.listing_id))
        );
        return own || blab || listing ? { 1: 1 } : null;
      }
      const plain = /FROM `(\w+)` WHERE `id` = \?/.exec(sql.replace(/\s+/g, ' '));
      if (plain) {
        const row = find(plain[1], params[0]);
        return row && activeIn(sql)(row) ? row : null;
      }
      return null;
    });

    dbMock.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM `mica_accounts`') && sql.includes('`id` IN')) {
        return accounts.filter((a) => params.includes(a.id));
      }
      if (sql.includes('FROM `mica_messages_attachments` a')) {
        const ids = (w.messageAttachments ?? [])
          .filter((a) => a.photo_id === params[0])
          .filter(
            (a) =>
              !/p\.`status` <> 'moderated'/.test(sql) ||
              find('mica_media', a.photo_id)?.status !== 'moderated'
          )
          .map((a) => find('mica_messages', a.message_id))
          .filter((m) => activeIn(sql, 'm.')(m))
          .map((m) => m!.conversation_id as number);
        return [...new Set(ids)].map((conversation_id) => ({ conversation_id }));
      }
      return [];
    });
  };

  /** Did anything read the row's body? The refusal has to come before that read. */
  const bodyWasRead = () =>
    dbMock.single.mock.calls.some(([sql]) => String(sql).includes('AS preview'));

  const GONE = 'That content no longer exists.';

  const message = (over: Partial<Row> = {}): Row => ({
    id: 12,
    citizenid: 'AUTHOR1',
    status: 'active',
    conversation_id: 40,
    preview: 'a private message',
    ...over
  });

  describe('a message', () => {
    it('files one from a thread the reporter is in', async () => {
      world({ rows: { mica_messages: [message()] }, members: [[40, REPORTER]] });

      const reply = await call('create', { targetTable: 'mica_messages', targetId: 12 });

      expect(reply).toMatchObject({ ok: true });
    });

    it('refuses one from a thread the reporter is not in, without reading it', async () => {
      world({ rows: { mica_messages: [message()] }, members: [[40, 'SOMEONE']] });

      const reply = await call('create', { targetTable: 'mica_messages', targetId: 12 });

      expect(reply.error).toBe(GONE);
      expect(bodyWasRead()).toBe(false);
      expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it('refuses one that has been unsent', async () => {
      world({
        rows: { mica_messages: [message({ status: 'deleted' })] },
        members: [[40, REPORTER]]
      });

      const reply = await call('create', { targetTable: 'mica_messages', targetId: 12 });

      expect(reply.error).toBe(GONE);
      expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it('asks membership of the thread on the row, by the reporter’s citizenid', async () => {
      world({ rows: { mica_messages: [message()] }, members: [[40, REPORTER]] });

      await call('create', { targetTable: 'mica_messages', targetId: 12 });

      const membership = dbMock.single.mock.calls.find(([sql]) =>
        String(sql).includes('mica_messages_participants')
      );
      expect(membership?.[0]).toMatch(/`left_at` IS NULL/);
      expect(membership?.[1]).toEqual([40, REPORTER]);
    });
  });

  describe('a Blabber DM', () => {
    const dm = (from: number, to: number, status = 'active'): Row => ({
      id: 21,
      citizenid: 'AUTHOR1',
      status,
      from_account: from,
      to_account: to,
      preview: 'a private DM'
    });
    const accounts = [
      { id: 1, citizenid: REPORTER, status: 'active' },
      { id: 2, citizenid: 'AUTHOR1', status: 'active' },
      { id: 3, citizenid: 'OTHER', status: 'active' }
    ];

    it('files one the reporter received', async () => {
      world({ rows: { mica_blabber_dms: [dm(2, 1)] }, accounts });

      const reply = await call('create', { targetTable: 'mica_blabber_dms', targetId: 21 });

      expect(reply).toMatchObject({ ok: true });
    });

    it('refuses one between two other accounts, without reading it', async () => {
      world({ rows: { mica_blabber_dms: [dm(2, 3)] }, accounts });

      const reply = await call('create', { targetTable: 'mica_blabber_dms', targetId: 21 });

      expect(reply.error).toBe(GONE);
      expect(bodyWasRead()).toBe(false);
      expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it('refuses one the reporter received on an account that is no longer live', async () => {
      world({
        rows: { mica_blabber_dms: [dm(2, 1)] },
        accounts: accounts.map((a) => (a.id === 1 ? { ...a, status: 'moderated' } : a))
      });

      const reply = await call('create', { targetTable: 'mica_blabber_dms', targetId: 21 });

      expect(reply.error).toBe(GONE);
    });

    it('refuses one that is no longer up', async () => {
      world({ rows: { mica_blabber_dms: [dm(2, 1, 'moderated')] }, accounts });

      const reply = await call('create', { targetTable: 'mica_blabber_dms', targetId: 21 });

      expect(reply.error).toBe(GONE);
    });
  });

  describe('a photo', () => {
    const photo: Row = { id: 30, citizenid: 'AUTHOR1', status: 'active', preview: 'data:...' };
    const blab = (status: string): Row => ({ id: 50, citizenid: 'AUTHOR1', status });

    it('refuses someone else’s photo nobody showed the reporter', async () => {
      world({ rows: { mica_media: [photo] } });

      const reply = await call('create', { targetTable: 'mica_media', targetId: 30 });

      expect(reply.error).toBe(GONE);
      expect(bodyWasRead()).toBe(false);
      expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it('files one attached to a live Blab', async () => {
      world({
        rows: { mica_media: [photo], mica_blabber: [blab('active')] },
        blabAttachments: [{ blab_id: 50, media_id: 30 }]
      });

      const reply = await call('create', { targetTable: 'mica_media', targetId: 30 });

      expect(reply).toMatchObject({ ok: true });
    });

    it('refuses one attached only to a Blab that is no longer up', async () => {
      world({
        rows: { mica_media: [photo], mica_blabber: [blab('moderated')] },
        blabAttachments: [{ blab_id: 50, media_id: 30 }]
      });

      const reply = await call('create', { targetTable: 'mica_media', targetId: 30 });

      expect(reply.error).toBe(GONE);
    });

    it('files one attached to a live listing', async () => {
      world({
        rows: {
          mica_media: [photo],
          mica_marketplace: [{ id: 60, citizenid: 'AUTHOR1', status: 'active' }]
        },
        listingAttachments: [{ listing_id: 60, media_id: 30 }]
      });

      const reply = await call('create', { targetTable: 'mica_media', targetId: 30 });

      expect(reply).toMatchObject({ ok: true });
    });

    /**
     * The attachment reads drop a moderated photo (MICA-339), so it is not visible and is
     * answered as gone. A photo its owner only deleted from their gallery still shows in the
     * thread, so it stays reportable: the rule is `<> 'moderated'`, not `= 'active'`.
     */
    it('refuses a moderated photo, on a live Blab or in the reporter’s own thread', async () => {
      const moderated = { ...photo, status: 'moderated' };
      world({
        rows: {
          mica_media: [moderated],
          mica_blabber: [blab('active')],
          mica_messages: [message()]
        },
        blabAttachments: [{ blab_id: 50, media_id: 30 }],
        messageAttachments: [{ message_id: 12, photo_id: 30 }],
        members: [[40, REPORTER]]
      });

      const reply = await call('create', { targetTable: 'mica_media', targetId: 30 });

      expect(reply.error).toBe(GONE);
      expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it('files one its owner deleted from the gallery but that still shows in the thread', async () => {
      world({
        rows: { mica_media: [{ ...photo, status: 'deleted' }], mica_messages: [message()] },
        messageAttachments: [{ message_id: 12, photo_id: 30 }],
        members: [[40, REPORTER]]
      });

      const reply = await call('create', { targetTable: 'mica_media', targetId: 30 });

      expect(reply).toMatchObject({ ok: true });
    });

    it('files one sent into a thread the reporter is in, and refuses it from one they are not', async () => {
      const rows = { mica_media: [photo], mica_messages: [message()] };
      const messageAttachments = [{ message_id: 12, photo_id: 30 }];

      world({ rows, messageAttachments, members: [[40, REPORTER]] });
      expect(await call('create', { targetTable: 'mica_media', targetId: 30 })).toMatchObject({
        ok: true
      });

      vi.clearAllMocks();
      dbMock.insert.mockResolvedValue(1);
      world({ rows, messageAttachments, members: [[40, 'SOMEONE']] });
      const reply = await call('create', { targetTable: 'mica_media', targetId: 30 });
      expect(reply.error).toBe(GONE);
      expect(dbMock.insert).not.toHaveBeenCalled();
    });
  });

  describe('a public row', () => {
    it.each(['mica_blabber', 'mica_marketplace', 'mica_accounts'])(
      'files a live one from %s and refuses one no longer up',
      async (table) => {
        world({
          rows: { [table]: [{ id: 5, citizenid: 'AUTHOR1', status: 'active', preview: 'x' }] }
        });
        expect(await call('create', { targetTable: table, targetId: 5 })).toMatchObject({
          ok: true
        });

        vi.clearAllMocks();
        world({
          rows: { [table]: [{ id: 5, citizenid: 'AUTHOR1', status: 'moderated', preview: 'x' }] }
        });
        const reply = await call('create', { targetTable: table, targetId: 5 });
        expect(reply.error).toBe(GONE);
        expect(dbMock.insert).not.toHaveBeenCalled();
      }
    );
  });

  it('answers a row the reporter cannot see exactly as it answers one that does not exist', async () => {
    world({ rows: { mica_messages: [message()] }, members: [] });
    const hidden = await call('create', { targetTable: 'mica_messages', targetId: 12 });
    vi.clearAllMocks();
    world({ rows: {}, members: [] });
    const missing = await call('create', { targetTable: 'mica_messages', targetId: 12 });

    expect(hidden).toEqual(missing);
  });

  it('answers the reporter’s own message, in a thread they are in, as their own', async () => {
    world({
      rows: { mica_messages: [message({ citizenid: REPORTER })] },
      members: [[40, REPORTER]]
    });

    const reply = await call('create', { targetTable: 'mica_messages', targetId: 12 });

    expect(reply.error).toMatch(/your own content/i);
  });

  /**
   * Closed by default: a table declared reportable with no visibility rule cannot be reported
   * by anyone. So every declared table has to file when everything is visible, or the rule is
   * missing — and this is where that shows, rather than in a player's hands.
   */
  it('has a visibility rule for every table declared reportable', async () => {
    const tables = Object.keys(REPORTABLE());
    expect(tables.length).toBeGreaterThanOrEqual(6);

    for (const table of tables) {
      vi.clearAllMocks();
      dbMock.insert.mockResolvedValue(1);
      const row: Row = {
        id: 5,
        citizenid: 'AUTHOR1',
        status: 'active',
        preview: 'x',
        conversation_id: 40,
        from_account: 2,
        to_account: 1
      };
      world({
        // The thread a photo was sent into, beside the target row itself.
        rows: {
          mica_messages: [message()],
          [table]: [row, ...(table === 'mica_messages' ? [message()] : [])]
        },
        members: [[40, REPORTER]],
        accounts: [{ id: 1, citizenid: REPORTER, status: 'active' }],
        messageAttachments: [{ message_id: 12, photo_id: 5 }]
      });

      const reply = await call('create', { targetTable: table, targetId: 5 });
      expect(reply, table).toMatchObject({ ok: true });
    }
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
      .filter(([sql]) => typeof sql === 'string' && sql.includes('mica_audit_logs'))
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
        target_table: 'mica_messages',
        target_id: 4
      },
      {
        id: 10,
        created_at: '2026-01-02T00:00:00Z',
        resolution: 'pending',
        target_table: 'mica_media',
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
        targetTable: 'mica_messages',
        details: { reportId: 9 }
      },
      {
        citizenid: ADMIN,
        action: 'viewed',
        service: 'reports',
        method: 'queue',
        targetId: 7,
        targetTable: 'mica_media',
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
      { id: 9, target_table: 'mica_messages', target_id: 4, resolution: 'pending' }
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
        target_table: 'mica_blabber',
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
        targetTable: 'mica_blabber',
        details: { reportId: 11 }
      }
    ]);
  });
});

describe('resolving is admin-only', () => {
  const pending = {
    id: 9,
    resolution: 'pending',
    target_table: 'mica_messages',
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
    const hide = dbMock.update.mock.calls.find((c: any[]) => /UPDATE `mica_messages`/.test(c[0]));
    if (!hide) throw new Error('the content should be hidden');
    expect(hide[0]).not.toMatch(/DELETE/i);
    expect(hide[1]).toEqual(expect.arrayContaining(['moderated']));

    const statements = dbMock.update.mock.calls.map((c: any[]) => c[0]);
    expect(statements.some((s: string) => /UPDATE `mica_reports`/.test(s))).toBe(true);

    const audited = dbMock.insert.mock.calls.some((c: any[]) => /mica_audit_logs/.test(c[0]));
    expect(audited, 'moderation must be recorded in the ledger').toBe(true);
  });

  it('dismissing leaves the content alone', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue(pending);

    const reply = await call('resolve', { id: 9, action: 'dismiss' }, ADMIN);
    expect(reply).toMatchObject({ resolution: 'dismissed' });

    const statements = dbMock.update.mock.calls.map((c: any[]) => c[0]);
    expect(statements.some((s: string) => /mica_messages/.test(s))).toBe(false);
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
      /UPDATE `mica_reports`/.test(c[0])
    );
    const moderateIndex = dbMock.update.mock.calls.findIndex((c: any[]) =>
      /UPDATE `mica_messages`/.test(c[0])
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
      /UPDATE `mica_messages`/.test(c[0])
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
      if (!/UPDATE `mica_reports`/.test(sql)) return true;
      await new Promise<void>((resolve) => gate.push(resolve));
      if (claimed) return false;
      claimed = true;
      return true;
    });

    const replies = new Map<string, any>();
    bridge.current = ADMIN;
    (globalThis as any).source = SRC;
    (globalThis as any).emitNet = vi.fn((...args: any[]) => replies.set(String(args[2]), args[3]));
    const handler = handlers.get('mica:server:reports:resolve')!;
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
      /UPDATE `mica_messages`/.test(c[0])
    );
    expect(takedowns).toHaveLength(1);
  });

  it('releases the claim when the takedown itself fails', async () => {
    // The claim has committed by then, so leaving it would mark a report actioned over
    // content that is still up — the compensating path `Hodlr` sell has always had.
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue(pending);
    dbMock.update.mockImplementation(async (sql: string) => {
      if (/UPDATE `mica_messages`/.test(sql)) throw new Error('takedown exploded');
      return true;
    });

    const reply = await call('resolve', { id: 9, action: 'moderate' }, ADMIN);

    expect(reply.error).toBeTruthy();
    const reportWrites = dbMock.update.mock.calls.filter((c: any[]) =>
      /UPDATE `mica_reports`/.test(c[0])
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
    target_table: 'mica_messages',
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
    const restore = statements.find((c: any[]) => /UPDATE `mica_messages`/.test(c[0]));
    if (!restore) throw new Error('the content should be restored');
    expect(restore[1]).toEqual(expect.arrayContaining(['active']));
  });

  it('undoing a dismissal leaves content alone — it was never hidden', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue({ ...actioned, resolution: 'dismissed' });

    await call('reopen', { id: 9 }, ADMIN);
    const touched = dbMock.update.mock.calls.some((c: any[]) => /mica_messages/.test(c[0]));
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
    const audit = dbMock.insert.mock.calls.find((c: any[]) => /mica_audit_logs/.test(c[0]));
    if (!audit) throw new Error('reopening should write an audit row');
    expect(audit[1]).toEqual(expect.arrayContaining(['unmoderated']));
  });
});
