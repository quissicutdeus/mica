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
import '../services/DirectMessages';
import '../services/DarkchatMessages';
import '../services/Glimpse';
import '../services/GlimpseComments';
import '../services/Marketplace';
import '../services/Spark';
import {
  isReportableTable,
  isReportCategory,
  REPORTABLE,
  summariseTarget
} from '../lib/moderation';

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
    glimpseAttachments?: { post_id: number; media_id: number }[];
    /** `[channel_id, citizenid]` pairs with `left_at` null: live Dark Chat members. */
    darkchatMembers?: [number, string][];
    sparkPhotos?: { profile_id: number; media_id: number; status?: string }[];
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
        const post = (w.glimpseAttachments ?? []).some(
          (a) => a.media_id === id && activeIn(sql, 'g.')(find('mica_glimpse', a.post_id))
        );
        const profile =
          sql.includes('FROM `mica_spark_photos` a') &&
          (w.sparkPhotos ?? []).some(
            (a) =>
              a.media_id === id &&
              // A photo row with no status yet is live, as `DEFAULT 'active'` makes it.
              activeIn(sql, 'a.')({ id: 0, citizenid: '', status: a.status ?? 'active' }) &&
              activeIn(sql, 'p.')(find('mica_spark', a.profile_id))
          );
        return own || blab || listing || post || profile ? { 1: 1 } : null;
      }
      // A Spark profile: live, and the reporter holds a live profile of their own.
      if (sql.includes('FROM `mica_spark` s')) {
        const [id, citizenid] = params;
        const target = find('mica_spark', id);
        const reporterHasOne = (rows.mica_spark ?? []).some(
          (r) => r.citizenid === citizenid && activeIn(sql, 'r.')(r)
        );
        return target && activeIn(sql, 's.')(target) && reporterHasOne ? { 1: 1 } : null;
      }
      // A Dark Chat message: live, written by a member (not an export's line), and the
      // caller a live member of its channel. The window is the database's to apply.
      if (sql.includes('FROM `mica_darkchat_messages` WHERE `id` = ?')) {
        const message = find('mica_darkchat_messages', params[0]);
        const byMember =
          !sql.includes('`author_member_id` IS NOT NULL') || message?.author_member_id;
        return message && activeIn(sql)(message) && byMember ? message : null;
      }
      if (sql.includes('FROM `mica_darkchat_members`')) {
        const [channel, citizenid] = params;
        return (w.darkchatMembers ?? []).some(([c, who]) => c === channel && who === citizenid)
          ? { 1: 1 }
          : null;
      }
      // A Glimpse comment is visible while it and the post it sits under are both live.
      if (sql.includes('FROM `mica_glimpse_comments` c')) {
        const comment = find('mica_glimpse_comments', params[0]);
        const post = comment && find('mica_glimpse', comment.post_id);
        return activeIn(sql, 'c.')(comment) && activeIn(sql, 'p.')(post) && comment && post
          ? { 1: 1 }
          : null;
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

  /**
   * MICA-255. A card is shown only in a deck, and a deck only to a player with a live profile,
   * so a profile is reportable while it is live by a reporter who holds one. Its photos are
   * reportable while the profile they are on is live.
   */
  describe('a Spark profile', () => {
    const profile = (status: string): Row => ({
      id: 70,
      citizenid: 'AUTHOR1',
      status,
      preview: 'a bio'
    });
    const mine = (status: string): Row => ({ id: 71, citizenid: REPORTER, status });

    it('files a live one when the reporter holds a live profile', async () => {
      world({ rows: { mica_spark: [profile('active'), mine('active')] } });
      expect(await call('create', { targetTable: 'mica_spark', targetId: 70 })).toMatchObject({
        ok: true
      });
    });

    it('refuses it to a reporter with no live profile, and refuses one no longer up', async () => {
      for (const rows of [
        [profile('active')],
        [profile('active'), mine('deleted')],
        [profile('deleted'), mine('active')],
        [profile('moderated'), mine('active')]
      ]) {
        vi.clearAllMocks();
        world({ rows: { mica_spark: rows } });
        const reply = await call('create', { targetTable: 'mica_spark', targetId: 70 });
        expect(reply.error).toBe(GONE);
        expect(bodyWasRead()).toBe(false);
        expect(dbMock.insert).not.toHaveBeenCalled();
      }
    });

    it('files a photo on a live profile, and refuses one only on a deleted profile', async () => {
      const photo: Row = { id: 30, citizenid: 'AUTHOR1', status: 'active', preview: 'data:...' };
      world({
        rows: { mica_media: [photo], mica_spark: [profile('active')] },
        sparkPhotos: [{ profile_id: 70, media_id: 30 }]
      });
      expect(await call('create', { targetTable: 'mica_media', targetId: 30 })).toMatchObject({
        ok: true
      });

      vi.clearAllMocks();
      world({
        rows: { mica_media: [photo], mica_spark: [profile('deleted')] },
        sparkPhotos: [{ profile_id: 70, media_id: 30 }]
      });
      const reply = await call('create', { targetTable: 'mica_media', targetId: 30 });
      expect(reply.error).toBe(GONE);
    });

    /**
     * MICA-429 review: a save replaces the profile's photo set and keeps the old rows, as
     * `replaced`. A photo that is no longer on the card is not shown to anyone, so it is not
     * reportable through the profile: only a live photo row counts.
     */
    it('refuses a photo the profile replaced, though the profile is live', async () => {
      const photo: Row = { id: 30, citizenid: 'AUTHOR1', status: 'active', preview: 'data:...' };
      world({
        rows: { mica_media: [photo], mica_spark: [profile('active')] },
        sparkPhotos: [{ profile_id: 70, media_id: 30, status: 'replaced' }]
      });
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
        to_account: 1,
        post_id: 7,
        channel_id: 30,
        author_member_id: 3
      };
      world({
        // The thread a photo was sent into, beside the target row itself.
        rows: {
          mica_messages: [message()],
          // The live post a Glimpse comment sits under.
          mica_glimpse: [{ id: 7, citizenid: 'AUTHOR1', status: 'active' }],
          [table]: [
            row,
            ...(table === 'mica_messages' ? [message()] : []),
            // A Spark card is reportable only by a player who holds a live profile.
            ...(table === 'mica_spark' ? [{ id: 6, citizenid: REPORTER, status: 'active' }] : [])
          ]
        },
        members: [[40, REPORTER]],
        darkchatMembers: [[30, REPORTER]],
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
    // never decide. Driven against one stub, each claim held until the test releases it.
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue(pending);

    let claimed = false;
    const gate: (() => void)[] = [];
    dbMock.update.mockImplementation(async (sql: string) => {
      // The claim only: the winner's record of what its takedown replaced (MICA-386) is a
      // later `mica_reports` write, and is not part of the race.
      if (!/UPDATE `mica_reports` SET `resolution` = \? WHERE `id` = \? AND/.test(sql)) return true;
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

    // Both read `pending` before either claims. The claims themselves take turns — one
    // decision about a row at a time (MICA-386) — so each is released as it arrives, and the
    // claim's own predicate is what refuses the second.
    await vi.waitFor(() => expect(gate).toHaveLength(1));
    const reads = dbMock.single.mock.calls.filter(([sql]) => /FROM `mica_reports`/.test(sql));
    expect(reads).toHaveLength(2);
    gate.shift()!();
    await vi.waitFor(() => expect(gate).toHaveLength(1));
    gate.shift()!();
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

/**
 * MICA-428, from Scorch's read: no purge holds a reported row any more, so a row under an open
 * report is erased with the rest of its owner's rows — kept, hidden from everyone. The report
 * has to keep working on it: staff read what was reported, a takedown records the row as
 * evidence and remembers `erased`, and neither a dismissal nor a reopen brings it back for the
 * owner who asked for everything to go.
 */
describe('a report on a row its owner erased (MICA-428)', () => {
  /** One reported message, erased, and the reports on it, as the database holds them. */
  let target: { status: string };
  let reports: Record<number, Record<string, unknown>>;

  beforeEach(() => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    target = { status: 'erased' };
    const report = (id: number) => ({
      id,
      citizenid: REPORTER,
      resolution: 'pending',
      status: 'active',
      target_table: 'mica_messages',
      target_id: 4,
      category: 'spam',
      target_prior_status: null
    });
    reports = { 9: report(9), 10: report(10) };
    dbMock.single.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = String(sql).replace(/\s+/g, ' ');
      if (text.startsWith('SELECT * FROM `mica_reports`'))
        return reports[Number(params[0])] ?? null;
      if (text.startsWith('SELECT `status` FROM `mica_messages`')) return { status: target.status };
      if (text.startsWith('SELECT `citizenid`, `status`, `message` AS preview')) {
        return {
          citizenid: 'AUTHOR',
          status: target.status,
          preview: 'bad words',
          conversation_id: 1
        };
      }
      return null;
    });
    dbMock.scalar.mockResolvedValue(0);
    dbMock.update.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = String(sql).replace(/\s+/g, ' ');
      const move =
        /^UPDATE `mica_messages` SET `status` = \?(, `updated_at` = `updated_at`)? WHERE `id` = \? AND `status` = \?$/.exec(
          text
        );
      if (move) {
        const [to, , from] = params as [string, number, string];
        if (target.status !== from) return false;
        target.status = to;
        return true;
      }
      const claim =
        /^UPDATE `mica_reports` SET `resolution` = \? WHERE `id` = \? AND `resolution` = \?$/.exec(
          text
        );
      if (claim) {
        const [to, id, from] = params as [string, number, string];
        if (reports[id]?.resolution !== from) return false;
        reports[id].resolution = to;
        return true;
      }
      const prior = /^UPDATE `mica_reports` SET `target_prior_status` = \? WHERE `id` = \?$/.exec(
        text
      );
      if (prior) {
        const [status, id] = params as [string, number];
        reports[id].target_prior_status = status;
        return true;
      }
      return true;
    });
  });

  it('(a) staff still read what was reported on the erased row', async () => {
    const summary = await summariseTarget('mica_messages', 4);
    expect(summary).toEqual({
      exists: true,
      citizenid: 'AUTHOR',
      status: 'erased',
      preview: 'bad words'
    });
  });

  it('(b) actioning it takes it down as evidence, and records erased for a reopen', async () => {
    const reply = await call('resolve', { id: 9, action: 'moderate' }, ADMIN);

    expect(reply).toMatchObject({ ok: true, resolution: 'actioned' });
    expect(target.status).toBe('moderated');
    expect(reports[9].target_prior_status).toBe('erased');
    expect(dbMock.insert.mock.calls.some((c: any[]) => /mica_audit_logs/.test(c[0]))).toBe(true);
  });

  it('(c) dismissing it as safe leaves the row erased: it never reappears', async () => {
    const reply = await call('resolve', { id: 10, action: 'dismiss' }, ADMIN);

    expect(reply).toMatchObject({ ok: true, resolution: 'dismissed' });
    expect(target.status).toBe('erased');
  });

  it("keeps a resolved report its filer's erase hid in staff history", async () => {
    dbMock.query.mockResolvedValue([]);
    await call('history', {}, ADMIN);

    const read = dbMock.query.mock.calls.find((c: any[]) =>
      /FROM `mica_reports`/.test(String(c[0]))
    )!;
    expect(String(read[0]).replace(/\s+/g, ' ')).toContain(
      "WHERE `status` IN ('active', 'erased') AND `resolution` <> 'pending'"
    );
  });

  it('(c) and reopening a takedown puts back erased, not active', async () => {
    await call('resolve', { id: 9, action: 'moderate' }, ADMIN);
    const reply = await call('reopen', { id: 9 }, ADMIN);

    expect(reply).toMatchObject({ ok: true, resolution: 'pending' });
    expect(target.status).toBe('erased');
  });
});

describe('history and undo', () => {
  const actioned = {
    id: 9,
    resolution: 'actioned',
    target_table: 'mica_messages',
    target_id: 4,
    category: 'spam',
    // What the takedown replaced (MICA-386); `moderationRestore.test.ts` has the other cases.
    target_prior_status: 'active'
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

/**
 * MICA-430: staff read what each edit of a reported row replaced. Admin only, by report id,
 * audited, and with no owner key, phone or binding column in the reply.
 */
describe('the versions of a reported row (MICA-430)', () => {
  const report = {
    id: 9,
    citizenid: REPORTER,
    target_table: 'mica_blabber',
    target_id: 70,
    resolution: 'pending',
    status: 'active'
  };
  const version = (id: number, values: Record<string, unknown>, extra: object = {}) => ({
    id,
    citizenid: 'AUTHOR1',
    edited_by: 'AUTHOR1',
    reason: 'edit',
    snapshot: JSON.stringify({
      values,
      context: { citizenid: 'AUTHOR1' },
      // Seconds, as `writeVersioned` writes it: UNIX_TIMESTAMP(updated_at).
      written_at: 1767225600
    }),
    // Seconds too: the read selects UNIX_TIMESTAMP(created_at), whatever oxmysql's typeCast does.
    created_at: 1769904000,
    ...extra
  });
  const versionReads = () =>
    dbMock.query.mock.calls.filter(([sql]) => String(sql).includes('`mica_versions`'));

  beforeEach(() => {
    dbMock.single.mockImplementation(async (sql: string) =>
      String(sql).includes('FROM `mica_reports`') ? { ...report } : null
    );
    dbMock.query.mockImplementation(async (sql: string) =>
      String(sql).includes('`mica_versions`')
        ? [
            version(1, { body: 'first draft' }),
            version(2, { body: 'second draft', citizenid: 'AUTHOR1' }, { edited_by: null })
          ]
        : []
    );
  });

  it('refuses a player who is not staff, and reads nothing', async () => {
    const reply = await call('versions', { id: 9 });
    expect(reply).toMatchObject({ key: 'server.reports.notAuthorised' });
    expect(versionReads()).toEqual([]);
  });

  it("answers the reported row's versions oldest first, with no owner key, and audits the read", async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    const reply = await call('versions', { id: 9 }, ADMIN);

    expect(reply).toEqual([
      {
        id: 1,
        reason: 'edit',
        replaced_at: '2026-02-01T00:00:00.000Z',
        // One format across the reply (MICA-430 review): ISO, never MariaDB's text.
        written_at: '2026-01-01T00:00:00.000Z',
        by_owner: true,
        values: [{ column: 'body', value: 'first draft' }]
      },
      {
        id: 2,
        reason: 'edit',
        replaced_at: '2026-02-01T00:00:00.000Z',
        written_at: '2026-01-01T00:00:00.000Z',
        by_owner: null,
        values: [{ column: 'body', value: 'second draft' }]
      }
    ]);
    // The row named by the filed report, never by the payload.
    expect(versionReads().map(([, params]) => params)).toEqual([['mica_blabber', 70]]);
    expect(String(versionReads()[0][0])).toContain('UNIX_TIMESTAMP(`created_at`) AS `created_at`');
    expect(JSON.stringify(reply)).not.toMatch(/AUTHOR1|citizenid|context|edited_by/);
    const audit = dbMock.insert.mock.calls.find(([sql]) => String(sql).includes('mica_audit_logs'));
    expect(audit?.[1]).toEqual(
      expect.arrayContaining([ADMIN, 'viewed', 'reports', 'versions', 70])
    );
  });

  it('answers nothing for a report whose table is no longer reportable', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    dbMock.single.mockResolvedValue({ ...report, target_table: 'mica_notes' });
    expect(await call('versions', { id: 9 }, ADMIN)).toEqual([]);
    expect(versionReads()).toEqual([]);
  });
});
