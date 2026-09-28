// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `micaimport` (MICA-233) against an in-memory stand-in for the database.
 *
 * The stand-in answers the importer's own statements by shape — the source tables it is
 * seeded with, the ledger, and the micaOS tables written to — so these cases can assert what a
 * dry run would write, what an apply did write, and that a second apply writes nothing. No SQL
 * is executed: whether the statements are valid MariaDB is the schema harness's question
 * (`scripts/test-schema.js`), not this suite's.
 */

type Row = Record<string, any>;

const db = vi.hoisted(() => ({
  source: new Map<string, Row[]>(),
  ledger: [] as Row[],
  contacts: [] as Row[],
  media: [] as Row[],
  conversations: [] as Row[],
  participants: [] as Row[],
  messages: [] as Row[],
  accounts: [] as Row[],
  blabs: [] as Row[],
  inserts: 0,
  nextId: 1000,
  /** The connection's `LAST_INSERT_ID()` and `@mica_import_id`, as oxmysql would keep them. */
  lastId: 0,
  importId: 0,
  /** A case sets this to make one statement fail inside a transaction. */
  failWhen: null as null | ((sql: string, params: any[]) => boolean),
  /** Throws a transaction as the timeout in `Database` does, for the next N calls. */
  timeouts: 0,
  /** Runs once after the next ledger insert, which lets a case fake a concurrent writer. */
  afterLedgerInsert: null as null | (() => void),
  pageReads: 0
}));

/** Key order as MariaDB compares row constructors: element by element, numbers as numbers. */
const compareTuples = vi.hoisted(() => (a: unknown[], b: unknown[]): number => {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === null || x === undefined) return -1;
    if (y === null || y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
});

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

const dbMock = vi.hoisted(() => {
  const answer = (rawSql: string, rawParams: any[]): { rows?: any; scalar?: any; id?: number } => {
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    const result = answerInner(sql, rawParams);
    if (result.id) db.lastId = result.id;
    return result;
  };

  const answerInner = (
    sql: string,
    rawParams: any[]
  ): { rows?: any; scalar?: any; id?: number } => {
    let params = rawParams;
    if (sql === 'SET @mica_import_id = LAST_INSERT_ID()') {
      db.importId = db.lastId;
      return {};
    }
    if (sql.includes('@mica_import_id')) {
      params = sql.includes('VALUES (@mica_import_id')
        ? [db.importId, ...rawParams]
        : [...rawParams, db.importId];
    }

    if (sql.includes('information_schema.TABLES')) {
      return { scalar: db.source.has(params[0]) ? 1 : null };
    }

    // The ledger.
    if (sql.startsWith('SELECT `source_key`, `target_id` FROM `mica_import_ledger`')) {
      return {
        rows: db.ledger.filter((r) => r.source === params[0] && r.source_table === params[1])
      };
    }
    if (sql.startsWith('SELECT `target_id` FROM `mica_import_ledger`')) {
      return {
        scalar:
          db.ledger.find(
            (r) =>
              r.source === params[0] && r.source_table === params[1] && r.source_key === params[2]
          )?.target_id ?? null
      };
    }
    if (sql.startsWith('INSERT INTO `mica_import_ledger`')) {
      const [citizenid, source, source_table, source_key, target_table, target_id] = params;
      if (
        db.ledger.some(
          (r) =>
            r.source === source && r.source_table === source_table && r.source_key === source_key
        )
      ) {
        throw new Error("Duplicate entry for key 'source_row_unique'");
      }
      db.ledger.push({ citizenid, source, source_table, source_key, target_table, target_id });
      if (db.afterLedgerInsert) {
        const hook = db.afterLedgerInsert;
        db.afterLedgerInsert = null;
        hook();
      }
      return { id: db.nextId++ };
    }

    // lb-phone's number → identifier lookups.
    const byNumber = /^SELECT `(\w+)` FROM `([a-z_]+)` WHERE `phone_number` = \?$/.exec(sql);
    if (byNumber && db.source.has(byNumber[2])) {
      return { rows: db.source.get(byNumber[2])!.filter((r) => r.phone_number === params[0]) };
    }

    // Key lookups for the chronological read: `WHERE \`id\` IN (…)`, answered in any order.
    const byIds = /^SELECT (.+?) FROM `([a-z_]+)` WHERE `(\w+)` IN \(/.exec(sql);
    if (byIds && db.source.has(byIds[2])) {
      const wanted = new Set(params.map(String));
      return {
        rows: db.source
          .get(byIds[2])!
          .filter((r) => wanted.has(String(r[byIds[3]])))
          .reverse()
      };
    }

    // Paged source reads: keyset on the named key, or offset for a table with none.
    const paged =
      /^SELECT (.+?) FROM `([a-z_]+)`(?: WHERE (.+?) > (.+?))?(?: ORDER BY (.+?))? LIMIT (\d+)(?: OFFSET (\d+))?$/.exec(
        sql
      );
    if (paged && db.source.has(paged[2])) {
      db.pageReads++;
      const keys = paged[5] ? paged[5].split(', ').map((k) => k.replace(/`/g, '')) : null;
      let rows = [...db.source.get(paged[2])!];
      if (keys) {
        rows.sort((a, b) =>
          compareTuples(
            keys.map((k) => a[k]),
            keys.map((k) => b[k])
          )
        );
        if (paged[3])
          rows = rows.filter(
            (r) =>
              compareTuples(
                keys.map((k) => r[k]),
                params
              ) > 0
          );
      }
      const offset = Number(paged[7] ?? 0);
      return { rows: rows.slice(offset, offset + Number(paged[6])) };
    }

    // Contacts.
    if (sql.startsWith('SELECT 1 FROM `mica_contacts`')) {
      return {
        scalar: db.contacts.some((c) => c.citizenid === params[0] && c.phone === params[1])
          ? 1
          : null
      };
    }
    if (sql.startsWith('INSERT INTO `mica_contacts`')) {
      const [citizenid, phone_id, firstname, lastname, phone, favorite] = params;
      const id = db.nextId++;
      db.contacts.push({ id, citizenid, phone_id, firstname, lastname, phone, favorite });
      return { id };
    }

    // Media.
    if (sql.startsWith('SELECT 1 FROM `mica_media`')) {
      return {
        scalar: db.media.some((m) => m.citizenid === params[0] && m.url === params[1]) ? 1 : null
      };
    }
    if (sql.startsWith('SELECT COALESCE(SUM(')) {
      return {
        // The owner is the last value: any hosted-URL patterns come first (MICA-293).
        scalar: db.media
          .filter((m) => m.citizenid === params.at(-1))
          .reduce((sum, m) => sum + (m.data?.length ?? 0), 0)
      };
    }
    if (sql.startsWith('INSERT INTO `mica_media`')) {
      const [citizenid, phone_id, kind, data, url, created_at] = params;
      const id = db.nextId++;
      db.media.push({ id, citizenid, phone_id, kind, data, url, created_at });
      return { id };
    }

    // Conversations.
    if (sql.startsWith('SELECT c.`id` FROM `mica_messages_conversations`')) {
      const [a, b] = params;
      const live = (id: number, phone: string) =>
        db.participants.some((p) => p.conversation_id === id && p.phone_id === phone);
      const found = db.conversations.find((c) => !c.is_group && live(c.id, a) && live(c.id, b));
      return { rows: found ? [{ id: found.id }] : [] };
    }
    if (sql.startsWith('INSERT INTO `mica_messages_conversations`')) {
      const [citizenid, is_group, name, participant_a, participant_b] = params;
      const id = db.nextId++;
      db.conversations.push({ id, citizenid, is_group, name, participant_a, participant_b });
      return { id };
    }
    if (sql.startsWith('INSERT INTO `mica_messages_participants`')) {
      const [conversation_id, citizenid, phone_id, role] = params;
      if (
        db.participants.some(
          (p) => p.conversation_id === conversation_id && p.phone_id === phone_id
        )
      ) {
        throw new Error("Duplicate entry for key 'conversation_phone_unique'");
      }
      const id = db.nextId++;
      db.participants.push({ id, conversation_id, citizenid, phone_id, role });
      return { id };
    }
    if (sql.startsWith('INSERT INTO `mica_messages`')) {
      const [conversation_id, citizenid, message, created_at] = params;
      const id = db.nextId++;
      db.messages.push({ id, conversation_id, citizenid, message, created_at });
      return { id };
    }

    // Blabber accounts and posts.
    if (sql.startsWith('SELECT `id` FROM `mica_accounts` WHERE `app` = ? AND `handle` = ?')) {
      const found = db.accounts.find(
        (a) => a.app === params[0] && a.handle === params[1] && a.citizenid === params[2]
      );
      return { rows: found ? { id: found.id } : null };
    }
    if (sql.startsWith('SELECT 1 FROM `mica_accounts` WHERE `app` = ? AND `handle` = ?')) {
      return {
        scalar: db.accounts.some((a) => a.app === params[0] && a.handle === params[1]) ? 1 : null
      };
    }
    if (sql.startsWith('SELECT 1 FROM `mica_blabber`')) {
      return {
        scalar: db.blabs.some((b) => b.account_id === params[0] && b.mouth_of === params[1])
          ? 1
          : null
      };
    }
    const counted = /^SELECT COUNT\(\*\) FROM `([a-z_]+)`$/.exec(sql);
    if (counted && db.source.has(counted[1])) {
      return { scalar: db.source.get(counted[1])!.length };
    }
    if (sql.startsWith('SELECT COUNT(*) FROM `mica_accounts`')) {
      return {
        scalar: db.accounts.filter((a) => a.citizenid === params[0] && a.app === params[1]).length
      };
    }
    if (sql.startsWith('SELECT `id` FROM `mica_accounts` WHERE `citizenid` = ?')) {
      const found = db.accounts.find((a) => a.citizenid === params[0] && a.app === params[1]);
      return { rows: found ? { id: found.id } : null };
    }
    if (sql.startsWith('INSERT INTO `mica_accounts`')) {
      const [citizenid, app, handle, display_name] = params;
      if (db.accounts.some((a) => a.app === app && a.handle === handle)) {
        throw new Error("Duplicate entry for key 'app_handle'");
      }
      const id = db.nextId++;
      db.accounts.push({ id, citizenid, app, handle, display_name });
      return { id };
    }
    if (sql.startsWith('SELECT `citizenid` FROM `mica_accounts`')) {
      return { scalar: db.accounts.find((a) => a.id === params[0])?.citizenid ?? null };
    }
    if (sql.startsWith('SELECT `root_id` FROM `mica_blabber`')) {
      return { scalar: db.blabs.find((b) => b.id === params[0])?.root_id ?? null };
    }
    if (sql.startsWith('INSERT INTO `mica_blabber`')) {
      const [citizenid, account_id, body, reply_to, root_id, mouth_of, created_at] = params;
      if (
        mouth_of !== null &&
        db.blabs.some((b) => b.account_id === account_id && b.mouth_of === mouth_of)
      ) {
        throw new Error('Duplicate entry for mouth');
      }
      const id = db.nextId++;
      db.blabs.push({ id, citizenid, account_id, body, reply_to, root_id, mouth_of, created_at });
      return { id };
    }

    throw new Error(`import.test: no stand-in answer for: ${sql}`);
  };

  return {
    query: vi.fn(async (sql: string, params: any[] = []) => answer(sql, params).rows ?? []),
    single: vi.fn(async (sql: string, params: any[] = []) => answer(sql, params).rows ?? null),
    scalar: vi.fn(async (sql: string, params: any[] = []) => answer(sql, params).scalar ?? null),
    insert: vi.fn(async (sql: string, params: any[] = []) => {
      db.inserts++;
      return answer(sql, params).id ?? 0;
    }),
    update: vi.fn(async () => true),
    /**
     * oxmysql's `transaction_async` as `Database.transaction` sees it: every statement or none,
     * and `false` rather than a throw when one fails.
     */
    transaction: vi.fn(async (queries: { query: string; params?: any[] }[]) => {
      if (db.timeouts > 0) {
        db.timeouts--;
        throw new Error('[Database] transaction did not answer within 60000ms; abandoning it.');
      }
      const tables = [
        'ledger',
        'contacts',
        'media',
        'conversations',
        'participants',
        'messages',
        'accounts',
        'blabs'
      ] as const;
      const snapshot = tables.map((t) => [...(db as any)[t]]);
      try {
        for (const { query, params = [] } of queries) {
          const sql = query.replace(/\s+/g, ' ').trim();
          if (db.failWhen?.(sql, params)) throw new Error('forced failure');
          if (sql.startsWith('INSERT')) db.inserts++;
          answer(query, params);
        }
        return true;
      } catch {
        tables.forEach((t, i) => {
          (db as any)[t].length = 0;
          (db as any)[t].push(...snapshot[i]);
        });
        return false;
      }
    })
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

/** Two characters, with the numbers micaOS knows them by. Nobody else exists. */
const directory = vi.hoisted(() => ({
  citizens: new Set(['CIT_A', 'CIT_B']),
  numbers: new Map<string, string>()
}));
vi.mock('../lib/PlayerDirectory', () => ({
  resolve: vi.fn(async (cid: string) =>
    directory.citizens.has(cid) ? { citizenid: cid, displayName: null, phone: null } : null
  ),
  resolveByPhone: vi.fn(async (phone: string) => {
    const cid = directory.numbers.get(phone);
    return cid ? { citizenid: cid, displayName: null, phone } : null;
  })
}));
/** micaOS's own number table: number → the phone it is on and who holds that phone. */
const micaNumbers = vi.hoisted(() => new Map<string, { phoneId: string; holder: string }>());
vi.mock('../lib/phoneNumbers', () => ({
  readCitizenIdByNumber: vi.fn(async (n: string) => micaNumbers.get(n)?.holder ?? null),
  readPhoneIdByNumber: vi.fn(async (n: string) => micaNumbers.get(n)?.phoneId ?? null)
}));
const phoneForCitizen = vi.hoisted(() => vi.fn(async (cid: string) => `phone-${cid}`));
vi.mock('../lib/phoneIdentity', () => ({ phoneForCitizen }));

import { runImport, type ImportReport } from '../lib/import';
import { __resetLbPrefix } from '../lib/import/lbPhone';
import { SKIP, threadTableUnusable } from '../lib/import/report';
import { __resetImportTargets, postsTarget, registerImportTarget } from '../lib/import/targets';
import { runImportCommand } from '../services/Import';
// Blabber registers itself as where imported posts go; core never names it.
import '../services/Blabber';

const blabberTarget = postsTarget();

const table = (report: ImportReport, name: string) => {
  const found = report.tables.find((t) => t.table === name);
  if (!found) throw new Error(`no report line for ${name}`);
  return found;
};

const skipped = (report: ImportReport, name: string): Record<string, number> =>
  Object.fromEntries(table(report, name).skipped.map((s) => [s.reason, s.count]));

const qbHistory = (lines: [string, string, string, string][]): string => {
  const days = new Map<string, Row[]>();
  for (const [date, time, sender, message] of lines) {
    const list = days.get(date) ?? [];
    list.push({ message, time, sender, type: 'message', data: [] });
    days.set(date, list);
  }
  return JSON.stringify([...days.entries()].map(([date, messages]) => ({ date, messages })));
};

const AB_THREAD = qbHistory([
  ['24-9-2026', '21:04', 'CIT_A', 'You up?'],
  ['24-9-2026', '21:05', 'CIT_B', "Yeah, what's up"],
  ['25-9-2026', '09:12', 'CIT_A', 'Meet at Legion']
]);

/** Denal's qb-phone fixture, as rows (`scripts/fixtures/import/qb-phone.sql`). */
const seedQb = (): void => {
  db.source.set('player_contacts', [
    { id: 1, citizenid: 'CIT_A', name: 'Bob Test', number: '555-0002' },
    { id: 2, citizenid: 'CIT_A', name: 'Bob Test', number: '555-0002' },
    { id: 3, citizenid: 'CIT_A', name: 'Downtown Cab', number: '555-0199' },
    { id: 4, citizenid: 'CIT_B', name: 'Alice Test', number: '555-0001' },
    { id: 5, citizenid: 'GHOST_CID', name: 'Nobody', number: '555-0003' }
  ]);
  db.source.set('phone_messages', [
    { id: 1, citizenid: 'CIT_A', number: '555-0002', messages: AB_THREAD },
    { id: 2, citizenid: 'CIT_B', number: '555-0001', messages: AB_THREAD },
    {
      id: 3,
      citizenid: 'CIT_A',
      number: '555-0199',
      messages: qbHistory([['25-9-2026', '10:30', 'CIT_A', 'Pickup at Pillbox please']])
    },
    {
      id: 4,
      citizenid: 'GHOST_CID',
      number: '555-0001',
      messages: qbHistory([['25-9-2026', '11:00', 'GHOST_CID', 'hello?']])
    }
  ]);
  db.source.set('phone_gallery', [
    {
      citizenid: 'CIT_A',
      image: 'https://cdn.example.com/qb/sunset.png',
      date: '2026-09-20 18:00:00'
    },
    {
      citizenid: 'CIT_A',
      image: 'https://cdn.example.com/qb/sunset.png',
      date: '2026-09-20 18:00:00'
    },
    {
      citizenid: 'CIT_B',
      image: 'https://cdn.example.com/qb/garage.jpg',
      date: '2026-09-21 12:30:00'
    },
    {
      citizenid: 'GHOST_CID',
      image: 'https://cdn.example.com/qb/ghost.png',
      date: '2026-09-22 08:00:00'
    }
  ]);
  db.source.set('phone_tweets', [
    {
      id: 1,
      citizenid: 'CIT_A',
      firstName: 'Alice',
      lastName: 'Test',
      message: 'First day in Los Santos',
      date: '2026-09-20 10:00:00'
    },
    {
      id: 2,
      citizenid: 'CIT_B',
      firstName: 'Bob',
      lastName: 'Test',
      message: 'Anyone selling a Sultan?',
      date: '2026-09-21 11:00:00'
    },
    {
      id: 3,
      citizenid: 'GHOST_CID',
      firstName: 'No',
      lastName: 'Body',
      message: 'boo',
      date: '2026-09-22 12:00:00'
    }
  ]);
};

beforeEach(() => {
  vi.clearAllMocks();
  db.source.clear();
  for (const list of [
    db.ledger,
    db.contacts,
    db.media,
    db.conversations,
    db.participants,
    db.messages,
    db.accounts,
    db.blabs
  ]) {
    list.length = 0;
  }
  db.inserts = 0;
  db.failWhen = null;
  db.timeouts = 0;
  db.afterLedgerInsert = null;
  db.pageReads = 0;
  micaNumbers.clear();
  directory.citizens = new Set(['CIT_A', 'CIT_B']);
  (globalThis as any).GetConvar = (_name: string, fallback: string) => fallback;
  directory.numbers = new Map([
    ['555-0001', 'CIT_A'],
    ['555-0002', 'CIT_B']
  ]);
  __resetLbPrefix();
  (globalThis as any).GetConvarInt = (_name: string, fallback: number) => fallback;
  (globalThis as any).emitNet = vi.fn();
});

describe('micaimport qb-phone', () => {
  it('a dry run counts every row once, with a reason for each it would not write, and writes nothing', async () => {
    seedQb();
    const report = await runImport('qb-phone', { apply: false });

    expect(report).toMatchObject({ source: 'qb-phone', apply: false });
    expect(db.inserts).toBe(0);
    expect(phoneForCitizen).not.toHaveBeenCalled();

    expect(table(report, 'player_contacts')).toMatchObject({ present: true, read: 5, written: 3 });
    expect(skipped(report, 'player_contacts')).toEqual({
      [SKIP.duplicateInSource]: 1,
      [SKIP.unresolvedOwner]: 1
    });

    // Eight messages across four rows: the A↔B thread twice (each side's copy), one to a
    // number no character holds, one from a citizenid that names nobody.
    expect(table(report, 'phone_messages')).toMatchObject({ read: 8, written: 3 });
    expect(skipped(report, 'phone_messages')).toEqual({
      [SKIP.duplicateInSource]: 3,
      [SKIP.thinThread]: 2
    });

    expect(table(report, 'phone_gallery')).toMatchObject({ read: 4, written: 2 });
    expect(skipped(report, 'phone_gallery')).toEqual({
      [SKIP.duplicateInSource]: 1,
      [SKIP.unresolvedOwner]: 1
    });

    expect(table(report, 'phone_tweets')).toMatchObject({ read: 3, written: 2 });
    // The ghost's tweet: its author's owner is nobody, and the reason says so.
    expect(skipped(report, 'phone_tweets')).toEqual({ [SKIP.unresolvedOwner]: 1 });
  });

  it('an apply writes what the dry run said, onto the owners and their phones', async () => {
    seedQb();
    const dry = await runImport('qb-phone', { apply: false });
    const applied = await runImport('qb-phone', { apply: true });

    for (const line of dry.tables) {
      expect(table(applied, line.table).written, line.table).toBe(line.written);
    }

    expect(
      db.contacts.map((c) => [c.citizenid, c.phone_id, c.firstname, c.lastname, c.phone])
    ).toEqual([
      ['CIT_A', 'phone-CIT_A', 'Bob', 'Test', '555-0002'],
      ['CIT_A', 'phone-CIT_A', 'Downtown', 'Cab', '555-0199'],
      ['CIT_B', 'phone-CIT_B', 'Alice', 'Test', '555-0001']
    ]);

    // One 1:1 thread between the two phones, both members, three messages in order.
    expect(db.conversations).toHaveLength(1);
    expect(db.conversations[0]).toMatchObject({
      is_group: 0,
      participant_a: 'phone-CIT_A',
      participant_b: 'phone-CIT_B'
    });
    expect(db.participants.map((p) => [p.citizenid, p.phone_id])).toEqual([
      ['CIT_A', 'phone-CIT_A'],
      ['CIT_B', 'phone-CIT_B']
    ]);
    expect(db.messages.map((m) => [m.citizenid, m.message])).toEqual([
      ['CIT_A', 'You up?'],
      ['CIT_B', "Yeah, what's up"],
      ['CIT_A', 'Meet at Legion']
    ]);
    // qb-phone's own day and time, not the moment of the import.
    expect((db.messages[0].created_at as Date).getFullYear()).toBe(2026);
    expect((db.messages[0].created_at as Date).getMonth()).toBe(8);
    expect((db.messages[0].created_at as Date).getHours()).toBe(21);

    expect(db.media.map((m) => [m.citizenid, m.kind, m.url, m.data])).toEqual([
      ['CIT_A', 'photo', 'https://cdn.example.com/qb/sunset.png', null],
      ['CIT_B', 'photo', 'https://cdn.example.com/qb/garage.jpg', null]
    ]);

    expect(db.accounts.map((a) => [a.citizenid, a.handle])).toEqual([
      ['CIT_A', 'alice_test'],
      ['CIT_B', 'bob_test']
    ]);
    expect(db.blabs.map((b) => [b.citizenid, b.body])).toEqual([
      ['CIT_A', 'First day in Los Santos'],
      ['CIT_B', 'Anyone selling a Sultan?']
    ]);

    // Every written row is in the ledger, against the character it was written for.
    expect(db.ledger.every((r) => r.source === 'qb-phone' && r.target_id > 0)).toBe(true);
  });

  it('a second apply writes nothing and says every row was already imported', async () => {
    seedQb();
    await runImport('qb-phone', { apply: true });
    const before = db.inserts;

    const again = await runImport('qb-phone', { apply: true });

    expect(db.inserts).toBe(before);
    for (const line of again.tables) expect(line.written, line.table).toBe(0);
    expect(skipped(again, 'player_contacts')[SKIP.alreadyImported]).toBe(3);
    expect(skipped(again, 'phone_messages')[SKIP.alreadyImported]).toBe(6);
    expect(skipped(again, 'phone_tweets')[SKIP.alreadyImported]).toBe(2);
  });

  it('a dry run after an apply also reports zero to write', async () => {
    seedQb();
    await runImport('qb-phone', { apply: true });
    const dry = await runImport('qb-phone', { apply: false });
    for (const line of dry.tables) expect(line.written, line.table).toBe(0);
  });

  it('does not duplicate a contact the player already has on micaOS', async () => {
    seedQb();
    db.contacts.push({ id: 1, citizenid: 'CIT_A', phone: '555-0199' });
    const report = await runImport('qb-phone', { apply: false });
    expect(skipped(report, 'player_contacts')[SKIP.alreadyInContacts]).toBe(1);
    expect(table(report, 'player_contacts').written).toBe(2);
  });

  it('skips a messages column it cannot read, with a reason, and carries on', async () => {
    seedQb();
    db.source
      .get('phone_messages')!
      .push({ id: 9, citizenid: 'CIT_A', number: '555-0002', messages: 'not json' });
    const report = await runImport('qb-phone', { apply: false });
    expect(skipped(report, 'phone_messages')[SKIP.unparseable]).toBe(1);
    expect(table(report, 'phone_messages').written).toBe(3);
  });
});

describe('missing and unreadable source tables', () => {
  it('reports every table as absent rather than failing when none exist', async () => {
    const report = await runImport('npwd', { apply: true });
    expect(report.tables.length).toBeGreaterThan(0);
    for (const line of report.tables) {
      expect(line).toMatchObject({ present: false, read: 0, written: 0, skipped: [] });
    }
    expect(db.inserts).toBe(0);
  });

  it('reports a table it cannot read under that table and imports the rest', async () => {
    seedQb();
    const original = dbMock.query.getMockImplementation()!;
    dbMock.query.mockImplementation(async (sql: string, params: any[] = []) => {
      if (flat(sql).includes('FROM `phone_gallery`')) throw new Error("Unknown column 'date'");
      return original(sql, params);
    });

    const report = await runImport('qb-phone', { apply: false });

    expect(table(report, 'phone_gallery')).toMatchObject({ present: true, read: 0, written: 0 });
    expect(table(report, 'phone_gallery').skipped[0].reason).toMatch(
      /could not read: Unknown column/
    );
    expect(table(report, 'phone_tweets').written).toBe(2);
  });
});

describe('media quota', () => {
  it('reports an inline image over the owner’s quota rather than writing it', async () => {
    (globalThis as any).GetConvarInt = (name: string, fallback: number) =>
      name === 'mica_media_quota_mb' ? 1 : fallback;
    const big = `data:image/png;base64,${'A'.repeat(700 * 1024)}`;
    db.source.set('npwd_phone_gallery', [
      { id: 1, identifier: 'CIT_A', image: big },
      { id: 2, identifier: 'CIT_A', image: `${big}B` },
      { id: 3, identifier: 'CIT_A', image: 'https://cdn.example.com/x.png' }
    ]);

    const report = await runImport('npwd', { apply: true });

    expect(table(report, 'npwd_phone_gallery')).toMatchObject({ read: 3, written: 2 });
    expect(skipped(report, 'npwd_phone_gallery')).toEqual({ [SKIP.overQuota]: 1 });
    expect(db.media.map((m) => (m.data ? 'inline' : m.url))).toEqual([
      'inline',
      'https://cdn.example.com/x.png'
    ]);
  });

  it('charges a link on the image host what a hosted photo costs, not nothing', async () => {
    // MICA-293: a hotlink elsewhere is still free, but one on the owner's image host is a file
    // on their storage. 1MiB holds three at the nominal 320KiB; the fourth is refused.
    (globalThis as any).GetConvarInt = (name: string, fallback: number) =>
      name === 'mica_media_quota_mb' ? 1 : fallback;
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_media_image_host' ? 'img.example.test' : fallback;
    db.source.set('npwd_phone_gallery', [
      ...[1, 2, 3, 4].map((id) => ({
        id,
        identifier: 'CIT_A',
        image: `https://img.example.test/p/${id}.webp`
      })),
      { id: 5, identifier: 'CIT_A', image: 'https://cdn.example.com/x.png' }
    ]);

    const report = await runImport('npwd', { apply: true });

    expect(table(report, 'npwd_phone_gallery')).toMatchObject({ read: 5, written: 4 });
    expect(skipped(report, 'npwd_phone_gallery')).toEqual({ [SKIP.overQuota]: 1 });
    expect(db.media.map((m) => m.url)).toEqual([
      'https://img.example.test/p/1.webp',
      'https://img.example.test/p/2.webp',
      'https://img.example.test/p/3.webp',
      'https://cdn.example.com/x.png'
    ]);
  });

  it('refuses a link that is not http(s) or an inline image', async () => {
    db.source.set('npwd_phone_gallery', [
      { id: 1, identifier: 'CIT_A', image: 'javascript:alert(1)' },
      { id: 2, identifier: 'CIT_A', image: 'nui://mica/img.png' }
    ]);
    const report = await runImport('npwd', { apply: true });
    expect(skipped(report, 'npwd_phone_gallery')).toEqual({ [SKIP.unsafeUrl]: 2 });
    expect(db.media).toHaveLength(0);
  });
});

describe('micaimport lb-phone', () => {
  const seedLb = (): void => {
    db.source.set('phone_phones', [
      { id: 'CIT_A', phone_number: '555-0001' },
      { id: 'CIT_B', phone_number: '555-0002' }
    ]);
    db.source.set('phone_phone_contacts', [
      {
        contact_phone_number: '555-0002',
        firstname: 'Bob',
        lastname: 'Test',
        favourite: 1,
        phone_number: '555-0001'
      },
      {
        contact_phone_number: '555-0003',
        firstname: 'No',
        lastname: 'Body',
        favourite: 0,
        phone_number: '555-0404'
      }
    ]);
    db.source.set('phone_message_channels', [
      { channel_id: 'lbchan-1', is_group: 0, name: null },
      { channel_id: 'lbchan-2', is_group: 0, name: null }
    ]);
    db.source.set('phone_message_members', [
      { channel_id: 'lbchan-1', phone_number: '555-0001' },
      { channel_id: 'lbchan-1', phone_number: '555-0002' },
      { channel_id: 'lbchan-2', phone_number: '555-0404' },
      { channel_id: 'lbchan-2', phone_number: '555-0001' }
    ]);
    db.source.set('phone_message_messages', [
      {
        id: 'lbmsg-1',
        channel_id: 'lbchan-1',
        sender: '555-0001',
        content: 'You up?',
        timestamp: '2026-09-24 21:04:00'
      },
      {
        id: 'lbmsg-2',
        channel_id: 'lbchan-1',
        sender: '555-0002',
        content: '',
        timestamp: '2026-09-24 21:05:00'
      },
      {
        id: 'lbmsg-4',
        channel_id: 'lbchan-2',
        sender: '555-0404',
        content: 'hello?',
        timestamp: '2026-09-25 11:00:00'
      }
    ]);
    db.source.set('phone_photos', [
      {
        phone_number: '555-0001',
        link: 'https://cdn.example.com/lb/drift.mp4',
        is_video: 1,
        timestamp: '2026-09-21 18:00:00'
      }
    ]);
    db.source.set('phone_twitter_accounts', [
      {
        username: 'alice_ls',
        display_name: 'Alice',
        phone_number: '555-0001',
        bio: null,
        profile_image: null
      },
      {
        username: 'ghost',
        display_name: 'Ghost',
        phone_number: '555-0404',
        bio: null,
        profile_image: null
      }
    ]);
    db.source.set('phone_twitter_tweets', [
      {
        id: 'lbtw-2',
        username: 'alice_ls',
        content: 'replying to myself',
        reply_to: 'lbtw-1',
        timestamp: '2026-09-20 11:00:00'
      },
      {
        id: 'lbtw-1',
        username: 'alice_ls',
        content: 'First day in Los Santos',
        reply_to: null,
        timestamp: '2026-09-20 10:00:00'
      },
      {
        id: 'lbtw-3',
        username: 'ghost',
        content: 'boo',
        reply_to: null,
        timestamp: '2026-09-22 12:00:00'
      }
    ]);
  };

  it('resolves owners by number through lb-phone’s own phones table when micaOS has not seen it', async () => {
    seedLb();
    // micaOS knows neither number: every owner comes from `phone_phones.id`.
    directory.numbers = new Map();

    const report = await runImport('lb-phone', { apply: true });

    expect(table(report, 'phone_phone_contacts')).toMatchObject({ read: 2, written: 1 });
    expect(db.contacts[0]).toMatchObject({ citizenid: 'CIT_A', phone: '555-0002', favorite: 1 });
    expect(table(report, 'phone_message_channels')).toMatchObject({ read: 2, written: 1 });
    expect(skipped(report, 'phone_message_channels')).toEqual({ [SKIP.thinThread]: 1 });
    expect(table(report, 'phone_message_messages')).toMatchObject({ read: 3, written: 1 });
    expect(skipped(report, 'phone_message_messages')).toEqual({
      [SKIP.noText]: 1,
      [SKIP.thinThread]: 1
    });
    expect(db.media[0]).toMatchObject({ citizenid: 'CIT_A', kind: 'video' });
  });

  it('keeps an lb-phone username as the handle and threads a reply under its parent', async () => {
    seedLb();
    const report = await runImport('lb-phone', { apply: true });

    expect(table(report, 'phone_twitter_accounts')).toMatchObject({ read: 2, written: 1 });
    expect(db.accounts.map((a) => a.handle)).toEqual(['alice_ls']);
    expect(table(report, 'phone_twitter_tweets')).toMatchObject({ read: 3, written: 2 });
    const [parent, reply] = db.blabs;
    expect(parent).toMatchObject({
      body: 'First day in Los Santos',
      reply_to: null,
      root_id: null
    });
    expect(reply).toMatchObject({
      body: 'replying to myself',
      reply_to: parent.id,
      root_id: parent.id
    });
  });

  it('takes the next free handle when another character already holds it', async () => {
    seedLb();
    db.accounts.push({ id: 1, citizenid: 'CIT_B', app: 'blabber', handle: 'alice_ls' });
    await runImport('lb-phone', { apply: true });
    expect(db.accounts.find((a) => a.citizenid === 'CIT_A')?.handle).toBe('alice_ls_2');
  });

  it('reads an lb_phone_ prefixed install the same way', async () => {
    db.source.set('lb_phone_phones', [{ id: 'CIT_A', phone_number: '555-0001' }]);
    db.source.set('lb_phone_photos', [
      {
        phone_number: '555-0001',
        link: 'https://cdn.example.com/a.png',
        is_video: 0,
        timestamp: null
      }
    ]);
    const report = await runImport('lb-phone', { apply: false });
    expect(table(report, 'lb_phone_photos')).toMatchObject({ present: true, read: 1, written: 1 });
  });
});

describe('micaimport npwd', () => {
  it('skips hidden messages and embeds, and turns a retweet into a mouth', async () => {
    db.source.set('npwd_messages_conversations', [{ id: 1, label: '', is_group_chat: 0 }]);
    db.source.set('npwd_messages_participants', [
      { conversation_id: 1, participant: '555-0001' },
      { conversation_id: 1, participant: '555-0002' }
    ]);
    db.source.set('npwd_messages', [
      {
        id: 1,
        message: 'You up?',
        user_identifier: 'CIT_A',
        conversation_id: '1',
        createdAt: '2026-09-24 21:04:00',
        visible: 1,
        author: '555-0001',
        is_embed: 0
      },
      {
        id: 2,
        message: 'deleted',
        user_identifier: 'CIT_B',
        conversation_id: '1',
        createdAt: '2026-09-24 21:05:00',
        visible: 0,
        author: '555-0002',
        is_embed: 0
      },
      {
        id: 3,
        message: '{"type":"contact"}',
        user_identifier: 'CIT_B',
        conversation_id: '1',
        createdAt: '2026-09-24 21:06:00',
        visible: 1,
        author: '555-0002',
        is_embed: 1
      }
    ]);
    db.source.set('npwd_twitter_profiles', [
      { id: 1, profile_name: 'alice_ls', identifier: 'CIT_A', avatar_url: null },
      { id: 2, profile_name: 'bobby', identifier: 'CIT_B', avatar_url: null }
    ]);
    db.source.set('npwd_twitter_tweets', [
      {
        id: 10,
        message: 'First day',
        createdAt: '2026-09-20 10:00:00',
        visible: 1,
        retweet: null,
        profile_id: 1
      },
      {
        id: 11,
        message: 'First day',
        createdAt: '2026-09-20 11:00:00',
        visible: 1,
        retweet: 10,
        profile_id: 2
      }
    ]);

    const report = await runImport('npwd', { apply: true });

    expect(table(report, 'npwd_messages')).toMatchObject({ read: 3, written: 1 });
    expect(skipped(report, 'npwd_messages')).toEqual({
      [SKIP.hiddenInSource]: 1,
      [SKIP.noText]: 1
    });
    const [original, mouth] = db.blabs;
    expect(mouth).toMatchObject({ citizenid: 'CIT_B', body: null, mouth_of: original.id });
  });
});

describe('the micaimport command', () => {
  it('refuses anyone but the server console, before reading anything', async () => {
    seedQb();
    await runImportCommand(5, ['qb-phone', '--apply']);

    expect(dbMock.query).not.toHaveBeenCalled();
    expect(dbMock.scalar).not.toHaveBeenCalled();
    expect((globalThis as any).emitNet).toHaveBeenCalledWith(
      'mica:client:shell:notify',
      5,
      expect.objectContaining({ key: 'server.schema.noPermission' })
    );
  });

  it('prints usage for a source it does not know, and reads nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runImportCommand(0, ['gksphone']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('usage: micaimport'));
    expect(dbMock.scalar).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('dry-runs by default and applies only with --apply', async () => {
    seedQb();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runImportCommand(0, ['qb-phone']);
    expect(db.inserts).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('dry run'));

    await runImportCommand(0, ['qb-phone', '--apply']);
    expect(db.inserts).toBeGreaterThan(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('APPLIED'));
    log.mockRestore();
  });
});

describe('each row and its ledger entry commit together', () => {
  it('keeps neither when the pair fails, reports it, and a re-run writes it', async () => {
    seedQb();
    // The ledger insert for the Downtown Cab contact fails, after the contact itself went in.
    db.failWhen = (sql, params) =>
      sql.startsWith('INSERT INTO `mica_import_ledger`') &&
      params[2] === 'player_contacts' &&
      params[3] === '3';

    const first = await runImport('qb-phone', { apply: true });

    expect(table(first, 'player_contacts').written).toBe(2);
    expect(skipped(first, 'player_contacts')[SKIP.writeFailed]).toBe(1);
    // Rolled back: no orphan contact, no ledger row claiming one.
    expect(db.contacts.map((c) => c.phone)).toEqual(['555-0002', '555-0001']);
    expect(
      db.ledger.some((r) => r.source_table === 'player_contacts' && r.source_key === '3')
    ).toBe(false);

    db.failWhen = null;
    const second = await runImport('qb-phone', { apply: true });
    expect(table(second, 'player_contacts').written).toBe(1);
    expect(db.contacts.map((c) => c.phone)).toEqual(['555-0002', '555-0001', '555-0199']);
  });

  it('writes a new thread, its participants and its ledger row as one batch', async () => {
    seedQb();
    db.failWhen = (sql) => sql.startsWith('INSERT INTO `mica_messages_participants`');

    const report = await runImport('qb-phone', { apply: true });

    expect(db.conversations).toHaveLength(0);
    expect(db.participants).toHaveLength(0);
    expect(skipped(report, 'phone_messages')[SKIP.writeFailed]).toBe(6);
  });
});

describe('MICA-233 review: identity, membership, completeness, scale', () => {
  /** A minimal lb-phone install: A and B own 555-0001 and 555-0002 in lb-phone's own table. */
  const seedLbPair = (): void => {
    db.source.set('phone_phones', [
      { id: 'CIT_A', phone_number: '555-0001' },
      { id: 'CIT_B', phone_number: '555-0002' }
    ]);
    db.source.set('phone_phone_contacts', [
      {
        contact_phone_number: '555-0002',
        firstname: 'Bob',
        lastname: 'Test',
        favourite: 0,
        phone_number: '555-0001'
      }
    ]);
    db.source.set('phone_message_channels', [
      { channel_id: 'c1', is_group: 0, name: null },
      { channel_id: 'c2', is_group: 0, name: null }
    ]);
    db.source.set('phone_message_members', [
      { channel_id: 'c1', phone_number: '555-0001' },
      { channel_id: 'c1', phone_number: '555-0002' },
      { channel_id: 'c2', phone_number: '555-0001' },
      { channel_id: 'c2', phone_number: '555-0404' },
      { channel_id: 'gone', phone_number: '555-0001' }
    ]);
    db.source.set('phone_message_messages', [
      {
        id: 'm-b',
        channel_id: 'c1',
        sender: '555-0002',
        content: 'second',
        timestamp: '2026-09-24 21:05:00'
      },
      {
        id: 'm-a',
        channel_id: 'c1',
        sender: '555-0001',
        content: 'first',
        timestamp: '2026-09-24 21:04:00'
      }
    ]);
  };

  it("lands an lb-phone row with lb-phone's owner when the framework gives that number to someone else", async () => {
    seedLbPair();
    // The framework's charinfo says 555-0001 is B's now; lb-phone says it was A's.
    directory.numbers = new Map([
      ['555-0001', 'CIT_B'],
      ['555-0002', 'CIT_A']
    ]);

    await runImport('lb-phone', { apply: true });

    expect(db.contacts[0]).toMatchObject({ citizenid: 'CIT_A', phone_id: 'phone-CIT_A' });
    expect(db.participants.map((p) => p.citizenid).sort()).toEqual(['CIT_A', 'CIT_B']);
    // Sender 555-0001 is A by lb-phone, so "first" is A's, not B's.
    expect(db.messages.map((m) => [m.citizenid, m.message])).toEqual([
      ['CIT_A', 'first'],
      ['CIT_B', 'second']
    ]);
  });

  it('skips a row whose number is now on a micaOS phone another character holds, rather than splitting it', async () => {
    seedLbPair();
    micaNumbers.set('555-0001', { phoneId: 'phone-X', holder: 'CIT_B' });

    const report = await runImport('lb-phone', { apply: true });

    expect(skipped(report, 'phone_phone_contacts')).toEqual({ [SKIP.numberReassigned]: 1 });
    expect(db.contacts).toHaveLength(0);
    // Both channels include 555-0001, so neither is written.
    expect(skipped(report, 'phone_message_channels')[SKIP.numberReassigned]).toBe(2);
    expect(skipped(report, 'phone_message_messages')).toEqual({ [SKIP.numberReassigned]: 2 });
    expect(db.conversations).toHaveLength(0);
    expect(db.messages).toHaveLength(0);
  });

  it('uses the micaOS phone on the number when the owner holds it, and phoneForCitizen otherwise', async () => {
    seedLbPair();
    micaNumbers.set('555-0001', { phoneId: 'phone-A-burner', holder: 'CIT_A' });
    await runImport('lb-phone', { apply: true });
    expect(db.contacts[0].phone_id).toBe('phone-A-burner');
    expect(db.participants.map((p) => p.phone_id).sort()).toEqual([
      'phone-A-burner',
      'phone-CIT_B'
    ]);
  });

  it('writes messages oldest first, whatever order the source ids are in', async () => {
    seedLbPair();
    await runImport('lb-phone', { apply: true });
    expect(db.messages.map((m) => m.message)).toEqual(['first', 'second']);
  });

  it('counts every lb-phone member row: written, unresolved, thin, or of a channel that is gone', async () => {
    seedLbPair();
    const report = await runImport('lb-phone', { apply: true });
    expect(table(report, 'phone_message_members')).toMatchObject({ read: 5, written: 2 });
    expect(skipped(report, 'phone_message_members')).toEqual({
      [SKIP.unresolvedMember]: 1,
      [SKIP.thinThread]: 1,
      [SKIP.threadNotInTable]: 1
    });
  });

  it('says why every message was skipped when the thread table is missing', async () => {
    seedLbPair();
    db.source.delete('phone_message_channels');
    const report = await runImport('lb-phone', { apply: false });
    expect(table(report, 'phone_message_messages')).toMatchObject({ read: 2, written: 0 });
    expect(skipped(report, 'phone_message_messages')).toEqual({
      [threadTableUnusable('phone_message_channels', false)]: 2
    });
  });

  it('refuses a message whose sender is not a member of the thread it would land in', async () => {
    directory.citizens.add('CIT_C');
    db.source.set('npwd_messages_conversations', [{ id: 1, label: '', is_group_chat: 0 }]);
    db.source.set('npwd_messages_participants', [
      { id: 1, conversation_id: 1, participant: '555-0001' },
      { id: 2, conversation_id: 1, participant: '555-0002' }
    ]);
    db.source.set('npwd_messages', [
      {
        id: 1,
        message: 'hi',
        user_identifier: 'CIT_A',
        conversation_id: '1',
        createdAt: null,
        visible: 1,
        author: '555-0001',
        is_embed: 0
      },
      {
        id: 2,
        message: 'intruder',
        user_identifier: 'CIT_C',
        conversation_id: '1',
        createdAt: null,
        visible: 1,
        author: '555-0003',
        is_embed: 0
      }
    ]);

    const report = await runImport('npwd', { apply: true });

    expect(skipped(report, 'npwd_messages')).toEqual({ [SKIP.senderNotMember]: 1 });
    expect(db.messages.map((m) => m.message)).toEqual(['hi']);
  });

  it('does not re-guess an NPWD owner from a number when its identifier names nobody', async () => {
    db.source.set('npwd_phone_contacts', [
      { id: 1, identifier: 'GHOST', number: '555-0001', display: 'x' }
    ]);
    const report = await runImport('npwd', { apply: true });
    expect(skipped(report, 'npwd_phone_contacts')).toEqual({ [SKIP.unresolvedOwner]: 1 });
  });

  it('notes an account folded into the owner’s oldest one at the per-app cap, and still writes it', async () => {
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_max_accounts_per_app' ? '1' : fallback;
    db.accounts.push({ id: 7, citizenid: 'CIT_A', app: 'blabber', handle: 'already_here' });
    db.source.set('npwd_twitter_profiles', [
      { id: 1, profile_name: 'alice_ls', identifier: 'CIT_A', avatar_url: null }
    ]);
    db.source.set('npwd_twitter_tweets', [
      { id: 10, message: 'hello', createdAt: null, visible: 1, retweet: null, profile_id: 1 }
    ]);

    const report = await runImport('npwd', { apply: true });

    expect(table(report, 'npwd_twitter_profiles')).toMatchObject({ read: 1, written: 1 });
    expect(skipped(report, 'npwd_twitter_profiles')).toEqual({ [SKIP.foldedAtCap]: 1 });
    expect(db.accounts).toHaveLength(1);
    expect(db.blabs[0]).toMatchObject({ account_id: 7, body: 'hello' });
  });

  it('treats a link whose ledger key another writer just recorded as linked, and carries on', async () => {
    seedLbPair();
    // The two phones already share a thread, so c1 is linked rather than created.
    db.conversations.push({ id: 500, citizenid: 'CIT_A', is_group: 0 });
    db.participants.push(
      { id: 501, conversation_id: 500, citizenid: 'CIT_A', phone_id: 'phone-CIT_A' },
      { id: 502, conversation_id: 500, citizenid: 'CIT_B', phone_id: 'phone-CIT_B' }
    );
    const original = dbMock.insert.getMockImplementation()!;
    let raced = false;
    dbMock.insert.mockImplementation(async (sql: string, params: any[] = []) => {
      if (
        !raced &&
        flat(sql).startsWith('INSERT INTO `mica_import_ledger`') &&
        params[3] === 'c1'
      ) {
        raced = true;
        db.ledger.push({
          source: 'lb-phone',
          source_table: 'phone_message_channels',
          source_key: 'c1',
          target_id: 500
        });
        throw new Error("Duplicate entry for key 'source_row_unique'");
      }
      return original(sql, params);
    });

    const report = await runImport('lb-phone', { apply: true });

    expect(raced).toBe(true);
    expect(table(report, 'phone_message_messages').written).toBe(2);
    expect(db.messages.every((m) => m.conversation_id === 500)).toBe(true);
  });

  it('pages a big table, writes it in chunks of a hundred, and prints progress', async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({
      id: i + 1,
      identifier: 'CIT_A',
      number: `555-${String(100000 + i)}`,
      display: `C ${i}`
    }));
    db.source.set('npwd_phone_contacts', rows);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const report = await runImport('npwd', { apply: true });

    expect(table(report, 'npwd_phone_contacts')).toMatchObject({ read: 5001, written: 5001 });
    expect(db.contacts).toHaveLength(5001);
    expect(dbMock.transaction).toHaveBeenCalledTimes(51);
    expect(db.pageReads).toBeGreaterThanOrEqual(6);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('npwd_phone_contacts: 5000 rows read')
    );
    log.mockRestore();
  });

  it('reports a timed-out chunk and finishes the run', async () => {
    seedQb();
    db.timeouts = 1;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const report = await runImport('qb-phone', { apply: true });

    expect(skipped(report, 'player_contacts')[SKIP.writeTimedOut]).toBe(3);
    expect(table(report, 'phone_tweets').written).toBe(2);
    error.mockRestore();
  });
});

describe('NPWD on ESX', () => {
  /** es_extended's multicharacter `users.identifier`: a `charN:` prefix and the license hash. */
  const ESX_ID = 'char1:3f9a2c7e5b1d4f60a8c2e9b7d1f3a5c7e9b1d3f5';

  it('resolves an ESX identifier through PlayerDirectory exactly as NPWD stored it', async () => {
    directory.citizens = new Set([ESX_ID, 'CIT_B']);
    directory.numbers = new Map([
      ['555-0001', ESX_ID],
      ['555-0002', 'CIT_B']
    ]);
    db.source.set('npwd_phone_contacts', [
      { id: 1, identifier: ESX_ID, number: '555-0002', display: 'Bob Test' },
      // The license alone, or a different character slot, is not this character.
      {
        id: 2,
        identifier: '3f9a2c7e5b1d4f60a8c2e9b7d1f3a5c7e9b1d3f5',
        number: '555-0003',
        display: 'x'
      },
      {
        id: 3,
        identifier: 'char2:3f9a2c7e5b1d4f60a8c2e9b7d1f3a5c7e9b1d3f5',
        number: '555-0004',
        display: 'y'
      }
    ]);
    db.source.set('npwd_messages_conversations', [{ id: 1, label: '', is_group_chat: 0 }]);
    db.source.set('npwd_messages_participants', [
      { id: 1, conversation_id: 1, participant: '555-0001' },
      { id: 2, conversation_id: 1, participant: '555-0002' }
    ]);
    db.source.set('npwd_messages', [
      {
        id: 1,
        message: 'hi from ESX',
        user_identifier: ESX_ID,
        conversation_id: '1',
        createdAt: null,
        visible: 1,
        author: '555-0001',
        is_embed: 0
      }
    ]);

    const report = await runImport('npwd', { apply: true });

    expect(db.contacts).toHaveLength(1);
    expect(db.contacts[0]).toMatchObject({ citizenid: ESX_ID, phone_id: `phone-${ESX_ID}` });
    expect(skipped(report, 'npwd_phone_contacts')).toEqual({ [SKIP.unresolvedOwner]: 2 });
    expect(db.messages[0]).toMatchObject({ citizenid: ESX_ID, message: 'hi from ESX' });
    expect(db.ledger.find((r) => r.target_table === 'mica_messages')?.citizenid).toBe(ESX_ID);
  });
});

describe('lb-phone messages and tweets in time order, without a sort per page', () => {
  it('scans by primary key once, then fetches rows by key in time order', async () => {
    db.source.set('phone_phones', [
      { id: 'CIT_A', phone_number: '555-0001' },
      { id: 'CIT_B', phone_number: '555-0002' }
    ]);
    db.source.set('phone_message_channels', [{ channel_id: 'c1', is_group: 0, name: null }]);
    db.source.set('phone_message_members', [
      { channel_id: 'c1', phone_number: '555-0001' },
      { channel_id: 'c1', phone_number: '555-0002' }
    ]);
    // Ids sort z, y, x; time says x, y, z.
    db.source.set('phone_message_messages', [
      {
        id: 'z',
        channel_id: 'c1',
        sender: '555-0001',
        content: 'third',
        timestamp: '2026-09-24 21:06:00'
      },
      {
        id: 'x',
        channel_id: 'c1',
        sender: '555-0002',
        content: 'first',
        timestamp: '2026-09-24 21:04:00'
      },
      {
        id: 'y',
        channel_id: 'c1',
        sender: '555-0001',
        content: 'second',
        timestamp: '2026-09-24 21:05:00'
      }
    ]);
    db.source.set('phone_twitter_accounts', [
      {
        username: 'alice_ls',
        display_name: 'A',
        phone_number: '555-0001',
        bio: null,
        profile_image: null
      }
    ]);
    db.source.set('phone_twitter_tweets', [
      {
        id: 'b',
        username: 'alice_ls',
        content: 'reply',
        reply_to: 'a2',
        timestamp: '2026-09-20 11:00:00'
      },
      {
        id: 'a2',
        username: 'alice_ls',
        content: 'parent',
        reply_to: null,
        timestamp: '2026-09-20 10:00:00'
      }
    ]);

    await runImport('lb-phone', { apply: true });

    expect(db.messages.map((m) => m.message)).toEqual(['first', 'second', 'third']);
    expect(db.blabs.map((b) => b.body)).toEqual(['parent', 'reply']);
    expect(db.blabs[1].reply_to).toBe(db.blabs[0].id);
    const sql = dbMock.query.mock.calls.map(([q]) => flat(String(q)));
    expect(sql.some((q) => /ORDER BY `timestamp`/.test(q))).toBe(false);
    expect(sql.some((q) => q.includes('FROM `phone_message_messages` WHERE `id` IN ('))).toBe(true);
  });
});

describe('where imported posts go (the posts target registry)', () => {
  const seedTweets = (): void => {
    db.source.set('npwd_twitter_profiles', [
      { id: 1, profile_name: 'alice_ls', identifier: 'CIT_A', avatar_url: null }
    ]);
    db.source.set('npwd_twitter_tweets', [
      { id: 10, message: 'hello', createdAt: null, visible: 1, retweet: null, profile_id: 1 }
    ]);
  };

  it('Blabber registered itself from its own service', () => {
    expect(blabberTarget).toMatchObject({ app: 'blabber', postTable: 'mica_blabber' });
  });

  it('counts accounts and posts under a reason when no app takes them, and writes nothing', async () => {
    seedTweets();
    __resetImportTargets();
    try {
      const report = await runImport('npwd', { apply: true });
      expect(skipped(report, 'npwd_twitter_profiles')).toEqual({ [SKIP.noPostsApp]: 1 });
      expect(skipped(report, 'npwd_twitter_tweets')).toEqual({ [SKIP.noPostsApp]: 1 });
      expect(db.accounts).toHaveLength(0);
      expect(db.blabs).toHaveLength(0);
    } finally {
      registerImportTarget('posts', blabberTarget!);
    }
  });

  it('says so when the owner has switched the app off', async () => {
    seedTweets();
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_disabled_apps' ? 'blabber' : fallback;
    const report = await runImport('npwd', { apply: true });
    expect(skipped(report, 'npwd_twitter_tweets')).toEqual({ [SKIP.postsAppDisabled]: 1 });
    expect(db.blabs).toHaveLength(0);
  });
});
