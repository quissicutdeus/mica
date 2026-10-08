// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * MICA-168: a player's export and delete of everything micaOS holds for their character.
 *
 * `Database` is mocked, so every statement is asserted as text; whether MariaDB accepts the
 * export's `SELECT … LENGTH(col) AS col_bytes … LIMIT ?` is `pnpm test:schema`'s question.
 * The whole service barrel is loaded, so `ownedTables()` is the real set and every owned
 * table's export plan is held to the rules below — not a sample of them.
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

vi.mock('../lib/orphanSweep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/orphanSweep')>();
  return { ...actual, purgeOwnedRows: vi.fn(actual.purgeOwnedRows) };
});

import '../services';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { __resetRateLimits } from '../lib/rateLimit';
import { AUDIT_LOG_TABLE } from '../lib/AuditLogger';
import { cascadeEdges, ownedTables, purgeOwnedRows } from '../lib/orphanSweep';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CASCADE_DEPENDENTS,
  EXPORT_EXCLUDED,
  SELF_SERVICE_EXCEPT,
  __resetPrivacyLimits,
  __setPrivacyClock,
  DELETE_INTERVAL_MS,
  EXPORT_BURST,
  EXPORT_LIMIT_CHARS,
  ROW_CAP,
  exportCategories,
  exportSql,
  planFor
} from '../services/Privacy';

const player = { current: 'CIT_A' };

/** Owned tables the export reads: all of them but the moderation ledger. */
const exported = () => ownedTables().filter(({ table }) => !EXPORT_EXCLUDED.has(table));
/** Tables a self-service delete never touches at all. */
const WHOLE_KEPT = [
  'mica_audit_logs',
  'mica_import_ledger',
  'mica_phones',
  'mica_phone_numbers',
  'mica_battery',
  'mica_lockscreen'
];

const call = async (action: string, data: unknown, citizenid = 'CIT_A') => {
  const handler = handlers.get(`mica:server:privacy:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);
  player.current = citizenid;
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls[0]?.[3];
};

let clock = 1_000_000;

/**
 * A database for the self-service purge: it plans before it deletes, so each owned table
 * answers the plan with `planRows` (one deletable row by default) and every link read with
 * nothing, and a `DELETE` removes one row the first time a table is asked and none after.
 */
let deletedOnce = new Set<string>();
let planRows: Record<string, { id: number; go: number; held: number; ex: number }[]> = {};
const answer = (sql: string): unknown => {
  const planned = /^SELECT t\.`id` AS `id`, .* FROM (\w+) t WHERE/.exec(sql)?.[1];
  if (planned) return planRows[planned] ?? [{ id: 1, go: 1, held: 0, ex: 0 }];
  if (sql.startsWith('SELECT')) return [];
  const table = /^DELETE FROM (\w+)/.exec(sql)?.[1] ?? sql;
  if (deletedOnce.has(table)) return { affectedRows: 0 };
  deletedOnce.add(table);
  return { affectedRows: 1 };
};
const auditInserts = () =>
  dbMock.insert.mock.calls.filter((c: any[]) => String(c[0]).includes(AUDIT_LOG_TABLE));
const selects = () =>
  dbMock.query.mock.calls.filter((c: any[]) => String(c[0]).startsWith('SELECT `'));

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  __resetPrivacyLimits();
  clock = 1_000_000;
  deletedOnce = new Set();
  planRows = {};
  __setPrivacyClock(() => clock);
  vi.spyOn(FrameworkBridge, 'getPlayer').mockImplementation(
    () => ({ citizenid: player.current, source: 5, setMeta: () => {} }) as any
  );
  dbMock.query.mockImplementation(async (sql: string) => answer(String(sql)));
  dbMock.insert.mockResolvedValue(1);
});

afterEach(() => {
  __setPrivacyClock();
  vi.restoreAllMocks();
});

describe('what an export selects (MICA-168)', () => {
  const plans = () => exported().map((owned) => ({ owned, plan: planFor(owned) }));
  const planOf = (table: string) => plans().find(({ owned }) => owned.table === table)!.plan!;

  it('has a plan for every exported table, so no category silently goes missing', () => {
    expect(exported().length).toBeGreaterThan(20);
    for (const { owned, plan } of plans()) expect(plan, owned.table).not.toBeNull();
  });

  it('selects no credential-looking column from any table', () => {
    const credential = /(^|_)(hash|salt|token|secret|password|passcode|pin)(_|$)/;
    for (const { owned, plan } of plans()) {
      for (const column of [...plan!.plain, ...plan!.sized]) {
        expect(credential.test(column), `${owned.table}.${column}`).toBe(false);
      }
    }
    expect(planOf('mica_lockscreen').withheld).toEqual(['passcode_hash', 'passcode_salt']);
  });

  it('exports media bytes as sizes and keeps a hosted url', () => {
    const media = planOf('mica_media');
    expect(media.sized.toSorted()).toEqual(['data', 'thumbnail']);
    expect(media.plain).toContain('url');
    expect(media.plain).not.toContain('data');
    expect(planOf('mica_contacts').sized).toEqual(['avatar']);

    const sql = exportSql(media);
    expect(sql).toContain('LENGTH(`data`) AS `data_bytes`');
    expect(sql).toContain('LENGTH(`thumbnail`) AS `thumbnail_bytes`');
    expect(sql).not.toMatch(/(^|[ ,])`data`,/);
  });

  it("withholds another player's identity and the other side of a thread", () => {
    expect(planOf('mica_reports').withheld).toContain('target_author');
    expect(planOf('mica_invoices').withheld).toContain('payee');
    expect(planOf('mica_messages_conversations').withheld).toEqual(
      expect.arrayContaining(['participant_a', 'participant_b', 'pair_key'])
    );
  });

  it('never selects the owner column, and binds the owner as a value', () => {
    for (const { owned, plan } of plans()) {
      expect(plan!.plain, owned.table).not.toContain(owned.column);
      expect(exportSql(plan!)).toMatch(new RegExp(`WHERE \`${owned.column}\` = \\? .*LIMIT \\?$`));
    }
  });
});

/**
 * Every exported table's column lists, pinned. The name rules in `planFor` (credential names,
 * byte types, `citizenId` columns) still run, belt and braces; this is what makes a new
 * column's exposure a decision rather than a default. When it fails, read the new column and
 * either add it here or withhold it in `Privacy.ts`.
 */
const EXPORTED_COLUMNS: Record<string, { plain: string[]; sized: string[]; withheld: string[] }> = {
  mica_notifications: {
    plain: [
      'id',
      'status',
      'created_at',
      'updated_at',
      'phone_id',
      'app',
      'kind',
      'title',
      'body',
      'avatar',
      'deep_link',
      'read_at',
      'cleared_at'
    ],
    sized: [],
    withheld: []
  },
  mica_accounts: {
    plain: [
      'id',
      'status',
      'created_at',
      'updated_at',
      'app',
      'handle',
      'display_name',
      'avatar',
      'bio'
    ],
    sized: [],
    withheld: []
  },
  mica_battery: {
    plain: ['id', 'status', 'created_at', 'updated_at', 'phone_id', 'level'],
    sized: [],
    withheld: []
  },
  mica_settings: {
    plain: [
      'id',
      'status',
      'created_at',
      'updated_at',
      'phone_id',
      'app',
      'setting_key',
      'setting_value'
    ],
    sized: [],
    withheld: []
  },
  mica_media: {
    plain: [
      'id',
      'status',
      'created_at',
      'updated_at',
      'phone_id',
      'kind',
      'url',
      'mime_type',
      'width',
      'height',
      'duration_ms',
      'byte_size',
      'alt_text'
    ],
    sized: ['data', 'thumbnail'],
    withheld: []
  },
  mica_blabber: {
    plain: [
      'id',
      'status',
      'created_at',
      'updated_at',
      'account_id',
      'body',
      'reply_to',
      'mouth_of',
      'root_id'
    ],
    sized: [],
    withheld: []
  },
  mica_blabber_attachments: { plain: ['id', 'blab_id', 'media_id'], sized: [], withheld: [] },
  mica_blabber_dms: {
    plain: [
      'id',
      'status',
      'created_at',
      'updated_at',
      'from_account',
      'to_account',
      'body',
      'read_at'
    ],
    sized: [],
    withheld: []
  },
  mica_blocklist: {
    plain: ['id', 'status', 'created_at', 'updated_at', 'phone_id', 'number'],
    sized: [],
    withheld: []
  },
  mica_phones: {
    plain: ['id', 'status', 'created_at', 'updated_at', 'phone_id', 'kind', 'claimed'],
    sized: [],
    withheld: []
  },
  mica_contacts: {
    plain: [
      'id',
      'status',
      'created_at',
      'updated_at',
      'phone_id',
      'firstname',
      'lastname',
      'phone',
      'email',
      'ringtone',
      'favorite'
    ],
    sized: ['avatar'],
    withheld: []
  },
  mica_messages_conversations: {
    plain: ['id', 'status', 'created_at', 'updated_at', 'is_group', 'name'],
    sized: [],
    withheld: ['participant_a', 'participant_b', 'pair_key']
  },
  mica_messages_participants: {
    plain: [
      'id',
      'conversation_id',
      'phone_id',
      'role',
      'status',
      'last_read',
      'created_at',
      'left_at',
      'archived_at',
      'updated_at'
    ],
    sized: [],
    withheld: []
  },
  mica_highscores: {
    plain: ['id', 'status', 'created_at', 'updated_at', 'app', 'score'],
    sized: [],
    withheld: []
  },
  mica_hodlr: {
    plain: ['id', 'status', 'created_at', 'updated_at', 'quantity'],
    sized: [],
    withheld: []
  },
  mica_import_ledger: {
    plain: [
      'id',
      'status',
      'created_at',
      'updated_at',
      'source',
      'source_table',
      'source_key',
      'target_table',
      'target_id'
    ],
    sized: [],
    withheld: []
  },
  mica_invoices: {
    plain: [
      'id',
      'status',
      'created_at',
      'updated_at',
      'from_label',
      'amount',
      'memo',
      'society',
      'resource',
      'expires_at',
      'paid_at'
    ],
    sized: [],
    withheld: ['payee']
  },
  mica_lockscreen: {
    plain: ['id', 'status', 'created_at', 'updated_at', 'phone_id'],
    sized: [],
    withheld: ['passcode_hash', 'passcode_salt']
  },
  mica_mail: {
    plain: [
      'id',
      'status',
      'created_at',
      'updated_at',
      'sender',
      'sender_address',
      'subject',
      'content',
      'read'
    ],
    sized: [],
    withheld: []
  },
  mica_marketplace: {
    plain: ['id', 'status', 'created_at', 'updated_at', 'title', 'price', 'description'],
    sized: [],
    withheld: []
  },
  mica_marketplace_attachments: {
    plain: ['id', 'listing_id', 'media_id'],
    sized: [],
    withheld: []
  },
  mica_messages: {
    plain: [
      'id',
      'status',
      'created_at',
      'updated_at',
      'conversation_id',
      'message',
      'reply_to_id',
      'external_sender'
    ],
    sized: [],
    withheld: []
  },
  mica_messages_attachments: { plain: ['id', 'message_id', 'photo_id'], sized: [], withheld: [] },
  mica_messages_reactions: {
    plain: ['id', 'message_id', 'emoji', 'created_at'],
    sized: [],
    withheld: []
  },
  mica_notes: {
    plain: ['id', 'status', 'created_at', 'updated_at', 'phone_id', 'title', 'content'],
    sized: [],
    withheld: []
  },
  mica_phone_call_log: {
    plain: ['id', 'status', 'created_at', 'updated_at', 'phone_id', 'kind', 'number', 'duration'],
    sized: [],
    withheld: []
  },
  mica_phone_numbers: {
    plain: ['id', 'status', 'created_at', 'updated_at', 'number', 'phone_id'],
    sized: [],
    withheld: []
  },
  mica_places: {
    plain: [
      'id',
      'status',
      'created_at',
      'updated_at',
      'phone_id',
      'name',
      'street_label',
      'x',
      'y',
      'z'
    ],
    sized: [],
    withheld: []
  },
  mica_reports: {
    plain: [
      'id',
      'status',
      'created_at',
      'updated_at',
      'target_table',
      'target_id',
      'category',
      'note',
      'resolution'
    ],
    sized: [],
    withheld: ['target_preview', 'target_author']
  }
};

describe('the exported columns are a decision (MICA-168)', () => {
  it('matches the pinned list for every exported table, and no table is unpinned', () => {
    const actual: Record<string, unknown> = {};
    for (const owned of exported()) {
      const plan = planFor(owned)!;
      actual[owned.table] = { plain: plan.plain, sized: plan.sized, withheld: plan.withheld };
    }
    expect(actual).toEqual(EXPORTED_COLUMNS);
  });

  it("withholds a report's preview of the reported content", () => {
    expect(EXPORTED_COLUMNS.mica_reports.withheld).toContain('target_preview');
  });
});

describe('privacy:export', () => {
  it('reads every owned table for the session citizenid only', async () => {
    const reply = await call('export', undefined);

    expect(reply.error).toBeUndefined();
    expect(selects()).toHaveLength(exported().length);
    // The moderation ledger is a record about the player, not theirs to take away.
    expect(selects().some((c: any[]) => String(c[0]).includes(AUDIT_LOG_TABLE))).toBe(false);
    expect(reply.categories.map((c: any) => c.category)).not.toContain('audit_logs');
    for (const c of selects()) expect(c[1]).toEqual(['CIT_A', ROW_CAP + 1]);
    expect(reply.categories.map((c: any) => c.category)).toContain('notes');
    // The id is all the server sends; the web labels it (`privacyLabels.test.ts`).
    expect(Object.keys(reply.categories[0]).toSorted()).toEqual([
      'category',
      'rows',
      'truncated',
      'withheld'
    ]);
    expect(reply.categories.map((c: any) => c.category)).toEqual(exportCategories());
    expect(reply.truncated).toBe(false);
  });

  it('refuses a payload that names a citizenid, and reads nothing', async () => {
    const reply = await call('export', { citizenid: 'CIT_VICTIM' });

    expect(reply).toMatchObject({ error: expect.any(String) });
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('marks a category cut at the row cap', async () => {
    const many = Array.from({ length: ROW_CAP + 1 }, (_, i) => ({ id: i + 1, title: 't' }));
    dbMock.query.mockImplementation(async (sql: string) =>
      sql.includes('FROM `mica_notes`') ? many : []
    );

    const reply = await call('export', undefined);
    const notes = reply.categories.find((c: any) => c.category === 'notes');

    expect(notes.rows).toHaveLength(ROW_CAP);
    expect(notes.truncated).toBe('rows');
    expect(reply.truncated).toBe(true);
  });

  it('marks the category that crosses the size budget and every one after it', async () => {
    const big = 'x'.repeat(200_000);
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, content: big }));
    const tables = ownedTables().map(({ table }) => table);
    const first = tables[0];
    dbMock.query.mockImplementation(async (sql: string) =>
      sql.includes(`FROM \`${first}\``) ? rows : []
    );

    const reply = await call('export', undefined);
    const spent = JSON.stringify(reply.categories.flatMap((c: any) => c.rows)).length;

    expect(reply.categories[0].truncated).toBe('size');
    expect(reply.categories[0].rows.length).toBeLessThan(8);
    expect(spent).toBeLessThanOrEqual(EXPORT_LIMIT_CHARS + 1000);
    for (const c of reply.categories.slice(1)) expect(c.truncated).toBe('size');
    // Past the budget nothing more is read.
    expect(selects()).toHaveLength(1);
    expect(reply.limitChars).toBe(EXPORT_LIMIT_CHARS);
  });

  it('refuses the whole export when one table cannot be read', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM `mica_notes`')) throw new Error('gone');
      return [];
    });

    const reply = await call('export', undefined);
    errors.mockRestore();

    expect(reply).toMatchObject({ key: 'server.privacy.exportFailed' });
    expect(reply.categories).toBeUndefined();
    expect(auditInserts()).toHaveLength(0);
  });

  it('allows three exports per rolling minute per citizenid', async () => {
    for (let i = 0; i < EXPORT_BURST; i++) {
      expect((await call('export', undefined)).error, `export ${i + 1}`).toBeUndefined();
      clock += 10_000;
    }

    // The fourth inside the minute waits for the oldest to leave the window: 60s - 30s.
    expect(await call('export', undefined)).toMatchObject({
      key: 'server.privacy.exportTooSoon',
      params: { seconds: 30 }
    });
    // Another character is not held by the first one's window.
    expect((await call('export', undefined, 'CIT_B')).error).toBeUndefined();

    // Rolling, not fixed: once the first leaves, exactly one more fits.
    clock += 30_000;
    expect((await call('export', undefined)).error).toBeUndefined();
    expect(await call('export', undefined)).toMatchObject({
      key: 'server.privacy.exportTooSoon',
      params: { seconds: 10 }
    });
  });

  it('audit-logs the export with counts and no content', async () => {
    dbMock.query.mockImplementation(async (sql: string) =>
      sql.includes('FROM `mica_notes`') ? [{ id: 1, title: 'SECRET TITLE' }] : []
    );

    await call('export', undefined);

    const [entry] = auditInserts();
    expect(entry[1].slice(0, 4)).toEqual(['CIT_A', 'viewed', 'privacy', 'export']);
    expect(entry[1][6]).toContain('"rows":1');
    expect(entry[1][6]).not.toContain('SECRET');
  });
});

describe('privacy:delete', () => {
  it('refuses without the exact confirmation word, and deletes nothing', async () => {
    for (const confirm of ['', 'delete', 'DELETE ', 'yes']) {
      const reply = await call('delete', { confirm });
      expect(reply, confirm).toMatchObject({
        key: 'server.privacy.confirmRequired',
        params: { word: 'DELETE' }
      });
    }
    expect(await call('delete', {})).toMatchObject({ error: expect.any(String) });
    expect(purgeOwnedRows).not.toHaveBeenCalled();
    expect(dbMock.query).not.toHaveBeenCalled();

    // A wrong word does not spend the hour.
    expect((await call('delete', { confirm: 'DELETE' })).error).toBeUndefined();
  });

  it('refuses a payload that names a citizenid before anything is purged', async () => {
    // The contract's object is strict, so an injected `citizenid` never reaches the handler:
    // the request is refused whole rather than run for somebody.
    const reply = await call('delete', { confirm: 'DELETE', citizenid: 'CIT_VICTIM' });

    expect(reply).toMatchObject({ error: expect.stringContaining('citizenid') });
    expect(purgeOwnedRows).not.toHaveBeenCalled();
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('purges through purgeOwnedRows for whichever character the session is', async () => {
    await call('delete', { confirm: 'DELETE' }, 'CIT_B');

    expect(purgeOwnedRows).toHaveBeenCalledTimes(1);
    expect(purgeOwnedRows).toHaveBeenCalledWith('CIT_B', {
      except: SELF_SERVICE_EXCEPT,
      cascade: { dependents: CASCADE_DEPENDENTS }
    });
    const deletes = dbMock.query.mock.calls.filter((c: any[]) => String(c[0]).startsWith('DELETE'));
    expect(deletes).toHaveLength(ownedTables().length - WHOLE_KEPT.length);
    for (const c of deletes) expect(c[1][0]).toBe('CIT_B');
  });

  it('keeps the evidence hold, and answers what it kept', async () => {
    // Message 1 may go; 2 and 3 are under open reports, so the plan keeps them.
    planRows.mica_messages = [
      { id: 1, go: 1, held: 0, ex: 0 },
      { id: 2, go: 0, held: 1, ex: 0 },
      { id: 3, go: 0, held: 1, ex: 0 }
    ];

    const reply = await call('delete', { confirm: 'DELETE' });

    expect(reply).toEqual({
      complete: true,
      removed: ownedTables().length - WHOLE_KEPT.length,
      kept: 2,
      failed: []
    });
    const heldDelete = dbMock.query.mock.calls.find((c: any[]) =>
      String(c[0]).startsWith('DELETE FROM mica_messages WHERE')
    )!;
    // By id, and the hold still in the statement for a report filed after the plan.
    expect(String(heldDelete[0])).toContain('mica_messages.`id` IN (?)');
    expect(String(heldDelete[0])).toContain('NOT EXISTS (SELECT 1 FROM `mica_reports` r');
    expect(heldDelete[1]).toContain(1);
    expect(heldDelete[1]).not.toContain(2);
  });

  it('reports a partial delete as partial', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DELETE FROM mica_notes ')) throw new Error('lock wait timeout');
      return answer(sql);
    });

    const reply = await call('delete', { confirm: 'DELETE' });
    errors.mockRestore();

    expect(reply.complete).toBe(false);
    expect(reply.failed).toEqual(['notes']);
    expect(reply.removed).toBe(ownedTables().length - WHOLE_KEPT.length - 1);
  });

  it('allows one delete an hour per citizenid', async () => {
    expect((await call('delete', { confirm: 'DELETE' })).error).toBeUndefined();

    expect(await call('delete', { confirm: 'DELETE' })).toMatchObject({
      key: 'server.privacy.deleteTooSoon',
      params: { minutes: 60 }
    });
    expect(purgeOwnedRows).toHaveBeenCalledTimes(1);

    clock += DELETE_INTERVAL_MS - 1;
    expect(await call('delete', { confirm: 'DELETE' })).toMatchObject({
      key: 'server.privacy.deleteTooSoon'
    });
    clock += 1;
    expect((await call('delete', { confirm: 'DELETE' })).error).toBeUndefined();
    expect(purgeOwnedRows).toHaveBeenCalledTimes(2);
  });

  it('audit-logs the delete after the purge, with counts and whether anything was held', async () => {
    const order: string[] = [];
    dbMock.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DELETE')) order.push('delete');
      return answer(sql);
    });
    dbMock.insert.mockImplementation(async () => {
      order.push('audit');
      return 1;
    });
    planRows.mica_media = [
      { id: 1, go: 1, held: 0, ex: 0 },
      { id: 2, go: 0, held: 1, ex: 0 }
    ];

    await call('delete', { confirm: 'DELETE' });

    expect(order.at(-1)).toBe('audit');
    expect(order.filter((o) => o === 'audit')).toHaveLength(1);
    const [entry] = auditInserts();
    expect(entry[1].slice(0, 4)).toEqual(['CIT_A', 'deleted', 'privacy', 'delete']);
    expect(JSON.parse(entry[1][6])).toEqual({
      complete: true,
      removed: ownedTables().length - WHOLE_KEPT.length,
      kept: 1,
      failed: [],
      held: true
    });
  });
});

describe('what a self-service delete keeps (MICA-168)', () => {
  const run = async () => {
    dbMock.query.mockImplementation(async (sql: string) => answer(sql));
    await call('delete', { confirm: 'DELETE' });
    return dbMock.query.mock.calls.map((c: any[]) => String(c[0]));
  };

  it('names only tables that exist, so a rename cannot quietly drop a keep', () => {
    const owned = ownedTables().map(({ table }) => table);
    for (const { table } of SELF_SERVICE_EXCEPT) expect(owned, table).toContain(table);
    expect(SELF_SERVICE_EXCEPT.map(({ table }) => table).toSorted()).toEqual([
      'mica_audit_logs',
      'mica_battery',
      'mica_import_ledger',
      'mica_invoices',
      'mica_lockscreen',
      'mica_phone_numbers',
      'mica_phones',
      'mica_reports'
    ]);
  });

  it('never deletes from the ledgers or the device tables', async () => {
    const statements = await run();
    for (const table of WHOLE_KEPT) {
      expect(
        statements.some((sql) => sql.includes(` ${table} `)),
        table
      ).toBe(false);
    }
  });

  it('keeps a pending report and an open invoice, and deletes the rest of each', async () => {
    const statements = await run();
    const pending = "mica_reports.`status` = 'active' AND mica_reports.`resolution` = 'pending'";
    const open = "mica_invoices.`status` = 'active'";
    // In the plan, as the rows that do not go and are not counted as kept...
    const plan = (table: string) =>
      statements.find((sql) => sql.startsWith('SELECT t.`id`') && sql.includes(`FROM ${table} t`))!;
    expect(plan('mica_reports')).toContain(
      "CASE WHEN t.`status` = 'active' AND t.`resolution` = 'pending' THEN 1 ELSE 0 END AS `ex`"
    );
    expect(plan('mica_invoices')).toContain(
      "CASE WHEN t.`status` = 'active' THEN 1 ELSE 0 END AS `ex`"
    );
    // ...and in the DELETE itself.
    const del = (table: string) =>
      statements.find((sql) => sql.startsWith(`DELETE FROM ${table} `))!;
    expect(del('mica_reports')).toContain(`NOT (${pending})`);
    expect(del('mica_invoices')).toContain(`NOT (${open})`);
  });
});

describe('the cascade guard covers every foreign key (MICA-168)', () => {
  /** `child.column -> parent` for every non-owner foreign key in the committed DDL. */
  const ddlEdges = (): string[] => {
    const sql = readFileSync(join(__dirname, '..', '..', 'mica.sql'), 'utf8');
    const out: string[] = [];
    let table = '';
    let column = '';
    for (const line of sql.split('\n')) {
      table = /CREATE TABLE IF NOT EXISTS `(\w+)`/.exec(line)?.[1] ?? table;
      column = /FOREIGN KEY \(`(\w+)`\)/.exec(line)?.[1] ?? column;
      const ref = /REFERENCES `(\w+)`/.exec(line)?.[1];
      if (ref && ref !== 'players') out.push(`${table}.${column} -> ${ref}`);
    }
    return out.toSorted();
  };

  it('derives the same foreign keys the DDL declares, so none is invisible to the guard', () => {
    const derived = cascadeEdges().map((e) => `${e.child}.${e.column} -> ${e.parent}`);
    expect(ddlEdges().length).toBeGreaterThan(20);
    expect(derived.toSorted()).toEqual(ddlEdges());
  });

  it('decides every child of a table the self-service delete deletes from', () => {
    const owned = new Set(ownedTables().map(({ table }) => table));
    const wholeKept = new Set(SELF_SERVICE_EXCEPT.filter((e) => !e.keep).map((e) => e.table));
    const dependents = new Set(CASCADE_DEPENDENTS);
    const edges = cascadeEdges();
    const undecided = edges.filter(
      (e) =>
        owned.has(e.parent) &&
        !wholeKept.has(e.parent) &&
        !owned.has(e.child) &&
        !dependents.has(e.child)
    );
    expect(
      undecided.map((e) => `${e.child}.${e.column} -> ${e.parent}`),
      'a new child table: add it to CASCADE_DEPENDENTS in Privacy.ts, or leave it keeping its parent'
    ).toEqual([]);
    for (const dependent of CASCADE_DEPENDENTS) {
      expect(owned.has(dependent), `${dependent} has an owner, so it is not a dependent`).toBe(
        false
      );
      expect(
        edges.some((e) => e.parent === dependent),
        `${dependent} has children`
      ).toBe(false);
      expect(
        edges.some((e) => e.child === dependent),
        `${dependent} is no child`
      ).toBe(true);
    }
  });

  it('guards each such parent against every owned child, in the DELETE it runs', async () => {
    dbMock.query.mockImplementation(async (sql: string) => answer(sql));
    await call('delete', { confirm: 'DELETE' });
    const statements = dbMock.query.mock.calls.map((c: any[]) => String(c[0]));
    const deleteOf = (table: string) =>
      statements.find((sql) => sql.startsWith(`DELETE FROM ${table} WHERE`));
    const owned = new Set(ownedTables().map(({ table }) => table));
    const wholeKept = new Set(WHOLE_KEPT);

    let guarded = 0;
    for (const e of cascadeEdges()) {
      if (!owned.has(e.parent) || wholeKept.has(e.parent) || CASCADE_DEPENDENTS.includes(e.child)) {
        continue;
      }
      const sql = deleteOf(e.parent);
      expect(sql, e.parent).toBeDefined();
      const reference =
        e.child === e.parent
          ? `SELECT DISTINCT c.\`${e.column}\` AS \`k\` FROM \`${e.child}\` c`
          : `FROM \`${e.child}\` c WHERE c.\`${e.column}\` = ${e.parent}.\`id\``;
      expect(sql, `${e.child}.${e.column} -> ${e.parent}`).toContain(reference);
      guarded += 1;
    }
    expect(guarded).toBeGreaterThan(10);
  });

  it('deletes children before their parents', async () => {
    dbMock.query.mockImplementation(async (sql: string) => answer(sql));
    await call('delete', { confirm: 'DELETE' });
    const order = dbMock.query.mock.calls
      .map((c: any[]) => /^DELETE FROM (\w+)/.exec(String(c[0]))?.[1])
      .filter((t): t is string => t !== undefined);
    for (const e of cascadeEdges()) {
      if (e.child === e.parent || !order.includes(e.child) || !order.includes(e.parent)) continue;
      expect(order.indexOf(e.child), `${e.child} before ${e.parent}`).toBeLessThan(
        order.indexOf(e.parent)
      );
    }
  });
});

describe('what a failed request costs (MICA-168)', () => {
  it('does not spend the hour on a partial delete, so the failed part can be retried', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DELETE FROM mica_notes ')) throw new Error('lock wait timeout');
      return answer(sql);
    });
    expect((await call('delete', { confirm: 'DELETE' })).complete).toBe(false);

    dbMock.query.mockImplementation(async (sql: string) => answer(sql));
    const retry = await call('delete', { confirm: 'DELETE' });
    errors.mockRestore();

    expect(retry.error).toBeUndefined();
    expect(retry.complete).toBe(true);
    // A complete one does spend it.
    expect(await call('delete', { confirm: 'DELETE' })).toMatchObject({
      key: 'server.privacy.deleteTooSoon'
    });
  });

  it('does not spend the hour on a purge that threw', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(purgeOwnedRows).mockRejectedValueOnce(new Error('pool gone'));
    expect(await call('delete', { confirm: 'DELETE' })).toMatchObject({
      key: 'server.privacy.deleteFailed'
    });
    errors.mockRestore();
    expect((await call('delete', { confirm: 'DELETE' })).error).toBeUndefined();
  });

  it('does not spend the minute on an export that failed', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.query.mockRejectedValueOnce(new Error('gone'));
    expect(await call('export', undefined)).toMatchObject({ key: 'server.privacy.exportFailed' });
    errors.mockRestore();
    expect((await call('export', undefined)).error).toBeUndefined();
  });

  it('answers a second request while the first is running as busy, and runs one purge', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(purgeOwnedRows).mockImplementationOnce(async () => {
      await gate;
      return { removed: 0, kept: 0, failures: [] };
    });
    const handler = handlers.get('mica:server:privacy:delete')!;
    const replies: any[] = [];
    (globalThis as any).emitNet = vi.fn((_e: string, _s: number, _cb: string, r: any) =>
      replies.push(r)
    );
    player.current = 'CIT_A';
    const first = handler('cb-1', { confirm: 'DELETE' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await handler('cb-2', { confirm: 'DELETE' });
    release();
    await first;

    expect(replies[0]).toMatchObject({ key: 'server.privacy.busy' });
    expect(replies[1]).toMatchObject({ complete: true });
    expect(purgeOwnedRows).toHaveBeenCalledTimes(1);
  });
});
