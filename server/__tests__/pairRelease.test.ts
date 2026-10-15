// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * MICA-342: a 1:1 that one side has left must not keep the pair's key.
 *
 * `findOneToOne` matches a pair only while both phones are still in the thread, and
 * `pair_key_unique` holds the pair while the row is `active`. A side leaving (the non-admin
 * `delete`) or taken out by a privacy delete left the thread active for the other side, still
 * holding the key. Every new thread between the two was then a duplicate key, answered as
 * `server.generic`. `test:endpoints` found it after a privacy delete.
 *
 * The real `Conversations` and `Privacy` handlers run here over a stand-in for the two tables.
 * The stand-in enforces `pair_key_unique` the way the generated column does, and it fails on any
 * statement it does not know, so a new query cannot pass by being answered with nothing. The
 * purge is stubbed to do what it does to these tables: it takes the player's membership rows and
 * keeps a thread another player is still in. The real purge against MariaDB is in
 * `test:endpoints`' privacy flow.
 */
interface Member {
  conversation_id: number;
  citizenid: string;
  device_id: string;
  role: string;
  status: string;
  left_at: string | null;
}

interface Person {
  citizenid: string;
  source: number;
  phone: string;
  number: string;
}

const { handlers, db, people, fw } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  const person = (n: number, hex: string) => ({
    citizenid: `CIT_${n}`,
    source: n,
    phone: hex.repeat(32),
    number: `555000${n}`
  });
  return {
    handlers: captured,
    db: {
      nextId: 1,
      conversations: new Map<number, Record<string, any>>(),
      participants: [] as Member[],
      /** Each statement that wrote, in order, plus `purge` where the purge ran. */
      log: [] as string[],
      /** `mica_phone_numbers` by phone: each person's phone carries their number (MICA-350). */
      numberRows: new Map<string, string>(),
      /** `mica_phone_numbers` legacy rows (`device_id IS NULL`), by citizenid. */
      legacyRows: new Map<string, string>()
    },
    people: [person(1, 'a'), person(2, 'b'), person(3, 'c')] as Person[],
    /** What `detectFramework` and the directory answer (MICA-350's es_extended number). */
    fw: {
      kind: 'unknown' as string,
      directory: new Map<string, { phone?: string }>(),
      directoryFails: false
    }
  };
});

const [ONE, TWO, OUTSIDER] = people;
const LINE_KEY = 'ext:5550199';

const bySource = (source: number) => people.find((p) => p.source === source);
const byNumber = (number: string) => people.find((p) => p.number === number);

const liveOn = (conversationId: number, deviceId: string) =>
  db.participants.some(
    (p) => p.conversation_id === conversationId && p.device_id === deviceId && p.left_at === null
  );

/** `pair_key` as the generated column computes it: NULL off `active` or with a side missing. */
const pairKey = (row: Record<string, any>): string | null =>
  row.status === 'active' && row.participant_a != null && row.participant_b != null
    ? [row.participant_a, row.participant_b].sort().join('|')
    : null;

/** The column list of an `INSERT INTO t (a, b) VALUES (?, ?)`, zipped with its values. */
const rowFrom = (sql: string, params: unknown[]): Record<string, any> => {
  const cols = /\(([^)]*)\)\s*VALUES/i.exec(sql)?.[1] ?? '';
  const names = cols.split(',').map((c) => c.trim().replace(/`/g, ''));
  return Object.fromEntries(names.map((name, i) => [name, params[i]]));
};

const unknownStatement = (kind: string, sql: string): never => {
  throw new Error(`stand-in: unknown ${kind}: ${sql.replace(/\s+/g, ' ').trim()}`);
};

vi.mock('../lib/Database', () => ({
  Database: {
    insert: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('mica_audit_logs')) return db.nextId++;
      if (sql.includes('INSERT INTO mica_messages_participants')) {
        const [conversation_id, citizenid, device_id, role] = params as [
          number,
          string,
          string,
          string
        ];
        if (liveOn(conversation_id, device_id)) return 0;
        if (
          db.participants.some(
            (p) => p.conversation_id === conversation_id && p.device_id === device_id
          )
        ) {
          throw new Error("Duplicate entry for key 'conversation_device_unique'");
        }
        db.participants.push({
          conversation_id,
          citizenid,
          device_id,
          role,
          status: 'active',
          left_at: null
        });
        return db.nextId++;
      }
      if (sql.includes('INSERT INTO `mica_messages_conversations`')) {
        const row = rowFrom(sql, params);
        const created = { ...row, id: db.nextId, status: row.status ?? 'active' };
        const key = pairKey(created);
        if (key && [...db.conversations.values()].some((c) => pairKey(c) === key)) {
          throw new Error(`Duplicate entry '${key}' for key 'pair_key_unique'`);
        }
        db.conversations.set(created.id, {
          ...created,
          created_at: '2026-10-15 12:00:00',
          updated_at: '2026-10-15 12:00:00'
        });
        return db.nextId++;
      }
      return unknownStatement('insert', sql);
    }),
    query: vi.fn(async (sql: string, params: unknown[]) => {
      // `findOneToOne`: both phones still in an active 1:1.
      if (sql.includes('p1.device_id = ?') && sql.includes('SELECT c.*')) {
        const [a, b] = params as [string, string];
        return [...db.conversations.values()].filter(
          (c) => !c.is_group && c.status === 'active' && liveOn(c.id, a) && liveOn(c.id, b)
        );
      }
      // `lineKeyOf`.
      if (sql.includes('SELECT c.participant_a, c.participant_b')) {
        const row = db.conversations.get(Number(params[0]));
        return row && row.status === 'active' && !row.is_group ? [row] : [];
      }
      // `findForPhone`: the inbox of one citizen on one phone, newest first.
      if (sql.includes('JOIN mica_messages_participants me')) {
        const [citizenid, deviceId] = params as [string, string];
        return [...db.conversations.values()]
          .filter((c) => c.status === 'active')
          .filter((c) =>
            db.participants.some(
              (p) =>
                p.conversation_id === c.id &&
                p.citizenid === citizenid &&
                p.device_id === deviceId &&
                p.left_at === null
            )
          )
          .sort((x, y) => y.id - x.id)
          .map((c) => ({ ...c, unread_count: 0, archived_at: null }));
      }
      const withNumber = (p: Member) => ({
        ...p,
        phone_number: people.find((who) => who.phone === p.device_id)?.number ?? null
      });
      // `findParticipantsForConversations`.
      if (sql.includes('mica_messages_participants') && sql.includes('IN (')) {
        const ids = params.map(Number);
        return db.participants
          .filter((p) => ids.includes(p.conversation_id) && p.left_at === null)
          .map(withNumber);
      }
      // `findParticipants`.
      if (sql.includes('WHERE p.conversation_id = ? AND p.left_at IS NULL')) {
        return db.participants
          .filter((p) => p.conversation_id === Number(params[0]) && p.left_at === null)
          .map(withNumber);
      }
      return unknownStatement('query', sql);
    }),
    scalar: vi.fn(async (sql: string, params: unknown[]) => {
      // `reconcilePairDuplicate`: the lowest active 1:1 both phones are in.
      if (sql.includes('ORDER BY c.id ASC')) {
        const [a, b] = params as [string, string];
        const ids = [...db.conversations.values()]
          .filter((c) => !c.is_group && c.status === 'active' && liveOn(c.id, a) && liveOn(c.id, b))
          .map((c) => c.id as number)
          .sort((x, y) => x - y);
        return ids[0] ?? null;
      }
      if (sql.includes('SELECT COUNT(*) FROM mica_messages WHERE conversation_id = ?')) return 0;
      return unknownStatement('scalar', sql);
    }),
    single: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM `mica_phone_numbers` WHERE `number` = ?')) {
        const who = byNumber(String(params[0]));
        return who ? { device_id: who.phone } : null;
      }
      return unknownStatement('single', sql);
    }),
    update: vi.fn(async (sql: string, params: unknown[]) => {
      const notLine = (side: unknown, pattern: string) =>
        typeof side === 'string' && !side.startsWith(pattern.replace(/%$/, ''));
      // `releasePairsOf`, its WHERE evaluated clause by clause, over every thread.
      if (
        sql.includes('c.participant_a = NULL, c.participant_b = NULL') &&
        !sql.includes('c.id = ?')
      ) {
        db.log.push('releasePairsOf');
        const [numberCitizen, legacyCitizen, framework, lineA, lineB, citizenid] = params as [
          string,
          string,
          string | null,
          string,
          string,
          string
        ];
        let released = 0;
        for (const c of db.conversations.values()) {
          const matches =
            !c.is_group &&
            c.status === 'active' &&
            notLine(c.participant_a, lineA) &&
            notLine(c.participant_b, lineB) &&
            db.participants.some(
              (p) =>
                p.conversation_id === c.id &&
                p.citizenid === citizenid &&
                p.left_at === null &&
                (p.device_id === c.participant_a || p.device_id === c.participant_b)
            );
          if (!matches) continue;
          // The number of the citizen's own live membership on a side, as the subquery reads it.
          const mine = db.participants.find(
            (p) =>
              p.conversation_id === c.id &&
              p.citizenid === numberCitizen &&
              p.left_at === null &&
              (p.device_id === c.participant_a || p.device_id === c.participant_b)
          );
          c.absent_number =
            (mine ? db.numberRows.get(mine.device_id) : undefined) ??
            db.legacyRows.get(legacyCitizen) ??
            framework;
          c.participant_a = null;
          c.participant_b = null;
          released += 1;
        }
        return released > 0;
      }
      // `releasePair`, its WHERE evaluated clause by clause.
      if (sql.includes('c.participant_a = NULL, c.participant_b = NULL')) {
        db.log.push('releasePair');
        const [
          numberPhone,
          legacyCitizen,
          framework,
          id,
          sideA,
          sideB,
          lineA,
          lineB,
          citizenid,
          deviceId
        ] = params as [
          string,
          string,
          string | null,
          number,
          string,
          string,
          string,
          string,
          string,
          string
        ];
        const c = db.conversations.get(id);
        const matches =
          c !== undefined &&
          !c.is_group &&
          c.status === 'active' &&
          (c.participant_a === sideA || c.participant_b === sideB) &&
          notLine(c.participant_a, lineA) &&
          notLine(c.participant_b, lineB) &&
          db.participants.some(
            (p) =>
              p.conversation_id === id &&
              p.citizenid === citizenid &&
              p.device_id === deviceId &&
              p.left_at === null
          );
        if (!matches) return false;
        c.absent_number =
          db.numberRows.get(numberPhone) ?? db.legacyRows.get(legacyCitizen) ?? framework;
        c.participant_a = null;
        c.participant_b = null;
        return true;
      }
      // `removeParticipant`.
      if (sql.includes('SET left_at = CURRENT_TIMESTAMP, status = ?')) {
        db.log.push('removeParticipant');
        const [status, conversationId, citizenid, deviceId] = params as [
          string,
          number,
          string,
          string
        ];
        const row = db.participants.find(
          (p) =>
            p.conversation_id === Number(conversationId) &&
            p.citizenid === citizenid &&
            p.device_id === deviceId &&
            p.left_at === null
        );
        if (!row) return false;
        Object.assign(row, { left_at: '2026-10-15 12:00:01', status });
        return true;
      }
      // `markDeletedByAdmin` and `discardEmptyDuplicate`, through `updateUnscoped`.
      if (sql.startsWith('UPDATE `mica_messages_conversations` SET `status` = ?')) {
        db.log.push('status');
        const row = db.conversations.get(Number(params.at(-1)));
        if (!row) return false;
        row.status = params[0];
        return true;
      }
      return unknownStatement('update', sql);
    })
  }
}));

vi.mock('../lib/PlayerDirectory', () => ({
  resolveByPhone: async (phone: string) => {
    const who = byNumber(phone);
    return who ? { citizenid: who.citizenid } : null;
  },
  resolveMany: async (citizenids: string[]) => {
    // oxmysql's shape: the statement and its parameters, then the driver's reason last.
    if (fw.directoryFails) {
      throw new Error(
        'mica was unable to execute a query!\nQuery: SELECT … WHERE citizenid IN (?)\n' +
          `${JSON.stringify(citizenids)}\nConnection lost`
      );
    }
    return new Map(
      citizenids.flatMap((id) => {
        const entry = fw.directory.get(id);
        return entry ? [[id, entry] as const] : [];
      })
    );
  }
}));

vi.mock('../lib/FrameworkBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/FrameworkBridge')>()),
  detectFramework: () => fw.kind
}));

/**
 * What the purge does to these two tables: the player's membership rows go, and a thread whose
 * other member is still in it stays. Its own SQL is `test:endpoints`' to prove, against MariaDB.
 */
vi.mock('../lib/orphanSweep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/orphanSweep')>()),
  purgeOwnedRows: vi.fn(async (citizenid: string) => {
    db.log.push('purge');
    const before = db.participants.length;
    db.participants = db.participants.filter((p) => p.citizenid !== citizenid);
    return { removed: before - db.participants.length, kept: 0, failures: [] };
  })
}));

import '../services/Conversations';
import '../services/Privacy';
import { conversations } from '../services/Conversations';
import {
  conversationForReader,
  type ConversationRepository,
  type ConversationRow
} from '../repositories/ConversationRepository';
import { Database } from '../lib/Database';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { __setDeviceResolvers } from '../lib/deviceIdentity';
import { __resetRateLimits } from '../lib/rateLimit';
import { __resetPrivacyLimits } from '../services/Privacy';

const repo = conversations.repo as ConversationRepository;

/** Drives `mica:server:<service>:<action>` as `who`, and returns what it replied. */
const call = async (who: Person, service: string, action: string, data: unknown) => {
  const handler = handlers.get(`mica:server:${service}:${action}`);
  if (!handler) throw new Error(`no handler for ${service}:${action}`);
  (globalThis as any).source = who.source;
  const emit = vi.fn();
  (globalThis as any).emitNet = emit;
  await handler('cb-1', data);
  return emit.mock.calls.at(-1)?.[3];
};

const open = async (from: Person, to: Person): Promise<number | undefined> =>
  (await call(from, 'conversations', 'create', { phone: to.number }))?.id;

const inbox = async (who: Person): Promise<number[]> =>
  ((await call(who, 'conversations', 'get', {}))?.rows ?? []).map((c: { id: number }) => c.id);

const thread = (id: number | undefined) => db.conversations.get(Number(id));

beforeEach(() => {
  db.nextId = 1;
  db.conversations.clear();
  db.participants = [];
  db.log = [];
  db.numberRows = new Map(people.map((p) => [p.phone, p.number]));
  db.legacyRows = new Map();
  fw.kind = 'unknown';
  fw.directory = new Map();
  fw.directoryFails = false;
  // Back to the stand-in, so a one-off failure a test queued and never reached cannot leak.
  for (const fn of Object.values(Database)) vi.mocked(fn).mockReset();
  __resetRateLimits();
  __resetPrivacyLimits();
  __setDeviceResolvers({
    forRequest: async (source) => bySource(source)!.phone,
    forCitizen: async (citizenid) => people.find((p) => p.citizenid === citizenid)!.phone,
    deviceInHand: () => undefined
  });
  vi.spyOn(FrameworkBridge, 'getPlayer').mockImplementation(
    (source: number) => ({ ...bySource(source)!, setMeta: () => {} }) as any
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a 1:1 one side leaves stops holding the pair (MICA-342)', () => {
  it('lets either side start a fresh thread after the non-admin leaves, and the admin keeps the old one', async () => {
    const old = await open(ONE, TWO);
    expect(typeof old).toBe('number');

    expect(await call(TWO, 'conversations', 'delete', { id: old })).toBe(true);
    // Unpaired while 2's membership was still live, then 2 left.
    expect(db.log).toEqual(['releasePair', 'removeParticipant']);
    expect(thread(old)).toMatchObject({
      status: 'active',
      participant_a: null,
      participant_b: null
    });

    const fresh = await open(TWO, ONE);
    expect(typeof fresh).toBe('number');
    expect(fresh).not.toBe(old);
    expect(await open(ONE, TWO)).toBe(fresh);

    expect(await inbox(ONE)).toEqual([fresh, old]);
    expect(await inbox(TWO)).toEqual([fresh]);
  });

  it('leaves a group as before, with nothing to unpair', async () => {
    const group = (
      await call(ONE, 'conversations', 'create', { participants: [TWO.number, OUTSIDER.number] })
    )?.id;
    expect(thread(group)).toMatchObject({ is_group: true, participant_a: null });

    expect(await call(TWO, 'conversations', 'delete', { id: group })).toBe(true);
    expect(db.log).toEqual(['releasePair', 'removeParticipant']);
    expect(thread(group)).toMatchObject({ status: 'active' });
    expect(await inbox(ONE)).toEqual([group]);
  });
});

describe("a privacy delete stops holding the deleter's pairs (MICA-342)", () => {
  it('lets 2 start a fresh thread with 1, and 2 keeps the old one, still active', async () => {
    const old = await open(ONE, TWO);

    const deleted = await call(ONE, 'privacy', 'delete', { confirm: 'DELETE' });
    expect(deleted).toMatchObject({ complete: true, failed: [] });
    // The pair was released while 1 was still in the thread to authorize it.
    expect(db.log).toEqual(['releasePairsOf', 'purge']);
    expect(thread(old)).toMatchObject({
      status: 'active',
      participant_a: null,
      participant_b: null
    });

    // 2 first: their create does not hand back the old thread 1 is no longer in.
    const fresh = await open(TWO, ONE);
    expect(typeof fresh).toBe('number');
    expect(fresh).not.toBe(old);
    expect(await open(ONE, TWO)).toBe(fresh);

    expect(await inbox(TWO)).toEqual([fresh, old]);
    expect(await inbox(ONE)).toEqual([fresh]);
  });

  it('lets 1 start the fresh thread too, which 2 then finds', async () => {
    const old = await open(TWO, ONE);
    await call(ONE, 'privacy', 'delete', { confirm: 'DELETE' });

    const fresh = await open(ONE, TWO);
    expect(typeof fresh).toBe('number');
    expect(fresh).not.toBe(old);
    expect(await open(TWO, ONE)).toBe(fresh);
    expect(await inbox(TWO)).toEqual([fresh, old]);
  });

  it("unpairs only the deleter's 1:1s with players, never a line thread or someone else's", async () => {
    const withTwo = await open(ONE, TWO);
    const notTheirs = await open(TWO, OUTSIDER);
    db.conversations.set(90, {
      id: 90,
      citizenid: ONE.citizenid,
      is_group: false,
      participant_a: ONE.phone,
      participant_b: LINE_KEY,
      status: 'active'
    });
    db.participants.push({
      conversation_id: 90,
      citizenid: ONE.citizenid,
      device_id: ONE.phone,
      role: 'member',
      status: 'active',
      left_at: null
    });

    await call(ONE, 'privacy', 'delete', { confirm: 'DELETE' });

    expect(thread(withTwo)).toMatchObject({ participant_a: null, participant_b: null });
    expect(thread(90)).toMatchObject({ participant_a: ONE.phone, participant_b: LINE_KEY });
    expect(thread(notTheirs)).toMatchObject({
      participant_a: TWO.phone,
      participant_b: OUTSIDER.phone
    });
  });

  it('purges nothing when the unpairing fails, so the retry starts clean', async () => {
    await open(ONE, TWO);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(Database.update).mockRejectedValueOnce(new Error('lock wait timeout'));

    expect(await call(ONE, 'privacy', 'delete', { confirm: 'DELETE' })).toMatchObject({
      key: 'server.privacy.deleteFailed'
    });
    expect(db.log).not.toContain('purge');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('conversations'));

    expect(await call(ONE, 'privacy', 'delete', { confirm: 'DELETE' })).toMatchObject({
      complete: true
    });
    expect(db.log).toEqual(['releasePairsOf', 'purge']);
  });
});

describe('releasePair names the thread, the leaving side and the citizen (MICA-342)', () => {
  it('unpairs only for a live member on a side of the pair, and for that one', async () => {
    const id = (await open(ONE, TWO))!;
    const paired = { participant_a: ONE.phone, participant_b: TWO.phone };

    // Not in the thread at all.
    expect(await repo.releasePair(id, OUTSIDER.citizenid, OUTSIDER.phone)).toBe(false);
    // A side's phone, named by someone who is not its member.
    expect(await repo.releasePair(id, OUTSIDER.citizenid, ONE.phone)).toBe(false);
    // A member, but on a phone that is not theirs in this thread.
    expect(await repo.releasePair(id, TWO.citizenid, ONE.phone)).toBe(false);
    // Another thread's id.
    expect(await repo.releasePair(id + 100, TWO.citizenid, TWO.phone)).toBe(false);
    expect(thread(id)).toMatchObject(paired);

    // The positive twin: the member, on their own side.
    expect(await repo.releasePair(id, TWO.citizenid, TWO.phone)).toBe(true);
    expect(thread(id)).toMatchObject({ participant_a: null, participant_b: null });
  });

  it('puts every one of those in the statement, bound, with the line prefix', async () => {
    const id = (await open(ONE, TWO))!;
    vi.mocked(Database.update).mockClear();

    await repo.releasePair(id, TWO.citizenid, TWO.phone);

    const [sql, params] = vi.mocked(Database.update).mock.calls[0];
    const where = sql.replace(/\s+/g, ' ');
    expect(where).toContain("WHERE c.id = ? AND c.is_group = 0 AND c.status = 'active'");
    expect(where).toContain('AND (c.participant_a = ? OR c.participant_b = ?)');
    expect(where).toContain('AND c.participant_a NOT LIKE ? AND c.participant_b NOT LIKE ?');
    expect(where).toContain(
      'p.conversation_id = c.id AND p.citizenid = ? AND p.device_id = ? AND p.left_at IS NULL'
    );
    // `updated_at` is held, so the other side's inbox order does not move.
    expect(where).toContain('c.updated_at = c.updated_at');
    expect(params).toEqual([
      TWO.phone,
      TWO.citizenid,
      null,
      id,
      TWO.phone,
      TWO.phone,
      'ext:%',
      'ext:%',
      TWO.citizenid,
      TWO.phone
    ]);
  });

  it('refuses without a citizen or a phone, before any statement', async () => {
    vi.mocked(Database.update).mockClear();
    expect(await repo.releasePair(1, '', TWO.phone)).toBe(false);
    expect(await repo.releasePair(1, TWO.citizenid, '')).toBe(false);
    expect(await repo.releasePairsOf('')).toBe(false);
    expect(Database.update).not.toHaveBeenCalled();
  });
});

describe('releasePairsOf is releasePair for every thread a citizen is still in (MICA-342)', () => {
  it("unpairs the citizen's live pairs and nothing they have left or are not in", async () => {
    const live = (await open(ONE, TWO))!;
    const left = (await open(ONE, OUTSIDER))!;
    db.participants.find(
      (p) => p.conversation_id === left && p.citizenid === ONE.citizenid
    )!.left_at = '2026-10-15 11:00:00';
    const notTheirs = (await open(TWO, OUTSIDER))!;

    expect(await repo.releasePairsOf(ONE.citizenid)).toBe(true);

    expect(thread(live)).toMatchObject({ participant_a: null, participant_b: null });
    expect(thread(left)).toMatchObject({ participant_a: ONE.phone, participant_b: OUTSIDER.phone });
    expect(thread(notTheirs)).toMatchObject({
      participant_a: TWO.phone,
      participant_b: OUTSIDER.phone
    });
    // Nothing left to release is `false`, not an error.
    expect(await repo.releasePairsOf(ONE.citizenid)).toBe(false);
  });

  it("puts releasePair's predicates in one statement, the citizen bound", async () => {
    vi.mocked(Database.update).mockClear();

    await repo.releasePairsOf(ONE.citizenid);

    expect(Database.update).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(Database.update).mock.calls[0];
    const where = sql.replace(/\s+/g, ' ');
    expect(where).toContain("WHERE c.is_group = 0 AND c.status = 'active'");
    expect(where).toContain('AND c.participant_a NOT LIKE ? AND c.participant_b NOT LIKE ?');
    expect(where).toContain(
      'p.conversation_id = c.id AND p.citizenid = ? AND p.left_at IS NULL ' +
        'AND (p.device_id = c.participant_a OR p.device_id = c.participant_b)'
    );
    expect(where).toContain('c.updated_at = c.updated_at');
    expect(params).toEqual([ONE.citizenid, ONE.citizenid, null, 'ext:%', 'ext:%', ONE.citizenid]);
  });
});

/**
 * MICA-350: the side still in a 1:1 nobody else is in sees the number of the side that is gone.
 *
 * The release records it in the same statement that unpairs the thread, and the list sends it
 * only to a member alone in a 1:1. Each case that sends it has a twin that must not.
 */
const rowsOf = async (who: Person): Promise<Record<string, any>[]> =>
  (await call(who, 'conversations', 'get', {}))?.rows ?? [];

const listed = async (who: Person, id: number | undefined) =>
  (await rowsOf(who)).find((row) => row.id === id);

describe('a 1:1 one side has gone from keeps its number (MICA-350)', () => {
  it("shows 1 the number of 2's phone after 2 leaves, and nothing on the fresh pair", async () => {
    const old = await open(ONE, TWO);
    await call(TWO, 'conversations', 'delete', { id: old });
    expect(thread(old)).toMatchObject({ absent_number: TWO.number, participant_a: null });

    const fresh = await open(ONE, TWO);
    expect(await listed(ONE, old)).toMatchObject({ absent_number: TWO.number });
    // The twin: a pair both sides are in carries no field at all.
    expect(await listed(ONE, fresh)).not.toHaveProperty('absent_number');
    expect(await listed(TWO, fresh)).not.toHaveProperty('absent_number');
  });

  it("shows 2 the number of 1's phone after 1's privacy delete", async () => {
    const old = await open(ONE, TWO);
    const kept = await open(TWO, OUTSIDER);
    await call(ONE, 'privacy', 'delete', { confirm: 'DELETE' });

    expect(await listed(TWO, old)).toMatchObject({ absent_number: ONE.number });
    expect(await listed(TWO, kept)).not.toHaveProperty('absent_number');
  });

  it("falls back to the leaver's legacy number, then to null, and still releases", async () => {
    const legacy = await open(ONE, TWO);
    db.numberRows.delete(TWO.phone);
    db.legacyRows.set(TWO.citizenid, '5550222');
    await call(TWO, 'conversations', 'delete', { id: legacy });
    expect(thread(legacy)).toMatchObject({ absent_number: '5550222', participant_a: null });

    const none = await open(ONE, OUTSIDER);
    db.numberRows.delete(OUTSIDER.phone);
    await call(OUTSIDER, 'conversations', 'delete', { id: none });
    expect(thread(none)).toMatchObject({ absent_number: null, participant_a: null });
    // Sent as null, not left out: the thread is the kind that has an absent side.
    expect(await listed(ONE, none)).toHaveProperty('absent_number', null);
  });

  it('records the framework number on es_extended, and null when the directory fails', async () => {
    fw.kind = 'esx';
    db.numberRows.clear();
    fw.directory.set(TWO.citizenid, { phone: '5550777' });
    const left = await open(ONE, TWO);
    await call(TWO, 'conversations', 'delete', { id: left });
    expect(thread(left)).toMatchObject({ absent_number: '5550777', participant_a: null });

    fw.directory.set(ONE.citizenid, { phone: '5550111' });
    const purged = await open(ONE, OUTSIDER);
    await call(ONE, 'privacy', 'delete', { confirm: 'DELETE' });
    expect(thread(purged)).toMatchObject({ absent_number: '5550111', participant_a: null });

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    fw.directoryFails = true;
    const failed = await open(TWO, OUTSIDER);
    expect(await call(OUTSIDER, 'conversations', 'delete', { id: failed })).toBe(true);
    expect(thread(failed)).toMatchObject({ absent_number: null, participant_a: null });
    // The last line of the driver's error only, never the statement and its parameters.
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0].join(' ')).toContain('Connection lost');
    expect(errors.mock.calls[0].join(' ')).not.toContain(OUTSIDER.citizenid);
  });

  it('records null for a framework number wider than the column, rather than failing', async () => {
    fw.kind = 'esx';
    db.numberRows.clear();
    fw.directory.set(TWO.citizenid, { phone: '1'.repeat(17) });
    const left = await open(ONE, TWO);
    await call(TWO, 'conversations', 'delete', { id: left });
    expect(thread(left)).toMatchObject({ absent_number: null, participant_a: null });
  });

  it('assigns the number before it nulls the pair, in both statements', async () => {
    const id = (await open(ONE, TWO))!;
    vi.mocked(Database.update).mockClear();
    await repo.releasePair(id, TWO.citizenid, TWO.phone, ' 5550999 ');
    await repo.releasePairsOf(ONE.citizenid);

    const [pair, pairParams] = vi.mocked(Database.update).mock.calls[0];
    const [ofCitizen] = vi.mocked(Database.update).mock.calls[1];
    for (const sql of [pair, ofCitizen]) {
      const flat = sql.replace(/\s+/g, ' ');
      expect(flat.indexOf('c.absent_number = COALESCE(')).toBeGreaterThan(-1);
      expect(flat.indexOf('c.absent_number =')).toBeLessThan(
        flat.indexOf('c.participant_a = NULL')
      );
      expect(flat).toContain('`device_id` IS NULL ORDER BY');
    }
    // The fallback is bound, trimmed, never interpolated.
    expect(pairParams?.slice(0, 3)).toEqual([TWO.phone, TWO.citizenid, '5550999']);
    expect(pair).not.toContain('5550999');
  });
});

describe('a thread started to a number nobody holds keeps that number (MICA-350)', () => {
  it('records the one number dialled, and the reply and the list carry it', async () => {
    const reply = await call(ONE, 'conversations', 'create', { participants: [' 5550404 '] });
    expect(reply).toMatchObject({ is_group: false, absent_number: '5550404' });
    expect(thread(reply.id)).toMatchObject({ absent_number: '5550404', participant_a: null });
    expect(await listed(ONE, reply.id)).toMatchObject({ absent_number: '5550404' });
  });

  it('records null for several numbers nobody holds', async () => {
    const reply = await call(ONE, 'conversations', 'create', {
      participants: ['5550404', '5550405']
    });
    expect(reply).toMatchObject({ is_group: false, absent_number: null });
    expect(thread(reply.id)).toMatchObject({ absent_number: null });
  });

  it('writes nothing on a pair or a group, whose create names no such column', async () => {
    const pair = await call(ONE, 'conversations', 'create', {
      participants: [TWO.number, '5550404']
    });
    const group = await call(ONE, 'conversations', 'create', {
      participants: [TWO.number, OUTSIDER.number, '5550404']
    });
    for (const reply of [pair, group]) {
      expect(reply).not.toHaveProperty('absent_number');
      expect(thread(reply.id)).not.toHaveProperty('absent_number');
    }
    expect(thread(pair.id)).toMatchObject({ participant_a: ONE.phone, participant_b: TWO.phone });
  });
});

describe('conversationForReader sends absent_number to a member alone in a 1:1 only (MICA-350)', () => {
  const row = (over: Partial<ConversationRow> = {}): ConversationRow => ({
    id: 7,
    citizenid: ONE.citizenid,
    is_group: false,
    participant_a: null,
    participant_b: null,
    absent_number: TWO.number,
    status: 'active',
    created_at: '2026-10-15 12:00:00',
    updated_at: '2026-10-15 12:00:00',
    ...over
  });
  const alone = { readerPhoneId: ONE.phone, memberPhones: [ONE.phone] };

  it('sends it to the reader alone in an unpaired 1:1', () => {
    expect(conversationForReader(row(), {}, alone)).toHaveProperty('absent_number', TWO.number);
  });

  it('never on a group, a line thread, a thread someone else is in, or without presence', () => {
    const cases = [
      conversationForReader(row({ is_group: true }), {}, alone),
      conversationForReader(row({ participant_a: ONE.phone, participant_b: LINE_KEY }), {}, alone),
      conversationForReader(row(), {}, { ...alone, memberPhones: [ONE.phone, TWO.phone] }),
      // A legacy membership with no phone id is somebody, as `nobodyElseIn` counts it.
      conversationForReader(row(), {}, { ...alone, memberPhones: [ONE.phone, null] }),
      // An empty list was never read, and is not "alone".
      conversationForReader(row(), {}, { ...alone, memberPhones: [] }),
      conversationForReader(row())
    ];
    for (const reply of cases) expect(reply).not.toHaveProperty('absent_number');
  });

  it('sends a stored value that is not a number of the column width as null', () => {
    expect(conversationForReader(row({ absent_number: '9'.repeat(40) }), {}, alone)).toHaveProperty(
      'absent_number',
      null
    );
  });
});
