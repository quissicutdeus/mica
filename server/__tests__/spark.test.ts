// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Spark (MICA-255): one unlisted account and one profile per player, a deck, likes and passes,
 * matches, and DMs only between matched accounts.
 *
 * `Database` is a small in-memory world answering each statement by its shape and honouring the
 * predicates the statement carries — the deck's exclusions above all — and every read projects
 * only what its SQL selects, so a citizenid in an answer is a citizenid the handler let through.
 * Being shape-matched, it proves nothing about MariaDB; the throwaway-MariaDB replay does that.
 */

const { dbMock, handlers, pushes, deleteThreadSpy } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    dbMock: {
      query: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      scalar: vi.fn(),
      single: vi.fn(),
      transaction: vi.fn()
    },
    handlers: captured,
    pushes: [] as { to: string | string[]; event: string; payload: any; options: any }[],
    deleteThreadSpy: vi.fn(async () => 0)
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/DiscordWebhook', () => ({ forwardReportFiled: vi.fn(), forwardAudit: vi.fn() }));

const bridge = vi.hoisted(() => ({ current: 'CIT_A' }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.current, source: 5, setMeta: () => {} }),
    getCitizenId: () => bridge.current,
    registerUsableItem: () => {}
  }
}));

vi.mock('../lib/appEvents', () => ({
  appEventChannel: (appId: string) => ({
    appId,
    push: (to: string, event: string, payload: any, options: any) => {
      pushes.push({ to, event, payload, options });
      return { delivered: true };
    },
    pushMany: (to: string[], event: string, payload: any, options: any) => {
      pushes.push({ to, event, payload, options });
      return { delivered: to, offline: [] };
    }
  })
}));

// The real DM service, with the thread delete observed rather than run: its SQL is pinned in
// `directMessages.test.ts`, and here the question is only whether Spark asks for it.
vi.mock('../services/DirectMessages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/DirectMessages')>()),
  deleteThread: deleteThreadSpy
}));

import {
  PASS_DAYS,
  SPARK_APP,
  __resetSparkSweep,
  spark,
  sweepSparkPasses
} from '../services/Spark';
import { registerAccountAppPolicy } from '../services/Accounts';
import { selfServicePurge } from '../services/Privacy';
import { REPORTABLE } from '../lib/moderation';
import { __resetRateLimits } from '../lib/rateLimit';
import { NOT_HELD_REPLY, installTestPhone, refusePhone } from './phoneStub';

type Row = Record<string, any>;

interface World {
  accounts: Row[];
  profiles: Row[];
  photos: Row[];
  media: Row[];
  swipes: Row[];
  matches: Row[];
  blocks: [number, number][];
  dms: Row[];
  nextId: number;
  /** Runs inside the match insert, after the row is in: what a racing request did meanwhile. */
  duringMatchInsert?: () => void;
  /** Throws from the next account insert, after `run` has put the racing save's row in. */
  accountInsertFails?: { error: Error; run: () => void };
}

let w: World;

const one = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const duplicate = (key: string) => new Error(`Duplicate entry 'x' for key '${key}'`);
const nextId = () => (w.nextId += 1);
const profileById = (id: unknown) => w.profiles.find((p) => p.id === Number(id));
const accountById = (id: unknown) => w.accounts.find((a) => a.id === Number(id));
const blocked = (a: unknown, b: unknown) =>
  w.blocks.some(([x, y]) => x === Number(a) && y === Number(b));
const projectProfile = (p: Row) => ({
  id: p.id,
  citizenid: p.citizenid,
  account_id: p.account_id,
  age: p.age,
  bio: p.bio,
  looking_for: p.looking_for,
  status: p.status
});
/** A profile on an active account, as the `JOIN mica_accounts a … a.status = 'active'` asks. */
const onActiveAccount = (sql: string, p: Row) =>
  !sql.includes("a.`status` = 'active'") || accountById(p.account_id)?.status === 'active';
const activeIf = (sql: string, alias: string, row?: Row) =>
  !sql.includes(`${alias}\`status\` = 'active'`) || row?.status === 'active';
const hasActivePhoto = (profileId: number) =>
  w.photos.some(
    (ph) =>
      ph.profile_id === profileId && w.media.find((m) => m.id === ph.media_id)?.status === 'active'
  );

const install = () => {
  dbMock.single.mockImplementation(async (raw: string, params: any[] = []) => {
    const sql = one(raw);
    if (sql.includes("FROM `mica_spark` WHERE `citizenid` = ? AND `status` <> 'deleted'")) {
      const p = w.profiles.find((x) => x.citizenid === params[0] && x.status !== 'deleted');
      return p ? projectProfile(p) : null;
    }
    if (sql.includes('FROM `mica_spark` s JOIN `mica_accounts` a') && sql.includes('s.`id` = ?')) {
      const p = profileById(params[0]);
      return p && activeIf(sql, 's.', p) && onActiveAccount(sql, p) ? projectProfile(p) : null;
    }
    if (sql.startsWith('SELECT `account_id`, `citizenid` FROM `mica_spark` WHERE `id` = ?')) {
      const p = profileById(params[0]);
      return p ? { account_id: p.account_id, citizenid: p.citizenid } : null;
    }
    if (sql.includes('FROM `mica_account_blocks` WHERE `blocker_account_id` = ?')) {
      return blocked(params[0], params[1]) ? { id: 1 } : null;
    }
    if (sql.includes('FROM `mica_spark_matches` m JOIN')) {
      const [a, b] = params;
      const hit = w.matches.find((m) => {
        const pa = profileById(m.profile_a);
        const pb = profileById(m.profile_b);
        if (!pa || !pb || !activeIf(sql, 'pa.', pa) || !activeIf(sql, 'pb.', pb)) return false;
        return (
          (pa.account_id === a && pb.account_id === b) ||
          (pa.account_id === b && pb.account_id === a)
        );
      });
      return hit ? { 1: 1 } : null;
    }
    if (sql.includes('FROM `mica_spark_matches` WHERE `profile_a` = ? AND `profile_b` = ?')) {
      const m = w.matches.find((x) => x.profile_a === params[0] && x.profile_b === params[1]);
      return m ? { ...m } : null;
    }
    if (sql.includes('FROM `mica_spark_matches` WHERE `id` = ? AND (')) {
      const [id, p1, p2] = params;
      const m = w.matches.find((x) => x.id === id && (x.profile_a === p1 || x.profile_b === p2));
      return m ? { ...m } : null;
    }
    if (sql.includes('FROM `mica_spark_swipes` WHERE `swiper_profile_id` = ?')) {
      const s = w.swipes.find(
        (x) =>
          x.swiper_profile_id === params[0] &&
          x.target_profile_id === params[1] &&
          (!sql.includes("`kind` = 'like'") || x.kind === 'like')
      );
      return s ? { 1: 1 } : null;
    }
    if (sql.startsWith('SELECT * FROM `mica_media` WHERE `id` = ?')) {
      const m = w.media.find((x) => x.id === params[0] && x.citizenid === params[1]);
      return m ? { ...m } : null;
    }
    if (sql.includes('FROM `mica_accounts` WHERE `id` = ? AND `citizenid` = ? AND `app` = ?')) {
      const a = w.accounts.find(
        (x) =>
          x.id === params[0] &&
          x.citizenid === params[1] &&
          x.app === params[2] &&
          x.status === 'active'
      );
      return a ? { ...a } : null;
    }
    if (sql.includes("FROM `mica_accounts` WHERE `id` = ? AND `app` = ? AND `status` = 'active'")) {
      const a = w.accounts.find(
        (x) => x.id === params[0] && x.app === params[1] && x.status === 'active'
      );
      return a ? { ...a } : null;
    }
    return null;
  });

  dbMock.scalar.mockImplementation(async (raw: string, params: any[] = []) => {
    const sql = one(raw);
    if (sql.startsWith('SELECT `kind` FROM `mica_spark_swipes`')) {
      const s = w.swipes.find(
        (x) => x.swiper_profile_id === params[0] && x.target_profile_id === params[1]
      );
      return s ? s.kind : null;
    }
    return null;
  });

  dbMock.query.mockImplementation(async (raw: string, params: any[] = []) => {
    const sql = one(raw);
    if (sql.includes('FROM `mica_accounts` WHERE `citizenid` = ? AND `app` = ?')) {
      return w.accounts
        .filter(
          (a) =>
            a.citizenid === params[0] &&
            a.app === params[1] &&
            (!sql.includes("`status` = 'active'") || a.status === 'active')
        )
        .map((a) => ({ ...a }));
    }
    if (
      sql.startsWith('SELECT p.`id`') &&
      sql.includes('FROM `mica_spark_photos` p JOIN `mica_media` m')
    ) {
      return w.photos
        .filter((ph) => params.includes(ph.profile_id))
        .map((ph) => ({ ph, m: w.media.find((x) => x.id === ph.media_id) }))
        .filter(({ m }) => m && (!sql.includes("m.`status` = 'active'") || m.status === 'active'))
        .sort((x, y) => x.ph.profile_id - y.ph.profile_id || x.ph.position - y.ph.position)
        .map(({ ph, m }) => ({
          id: ph.id,
          profile_id: ph.profile_id,
          media_id: ph.media_id,
          kind: m!.kind ?? null,
          data: m!.data ?? null,
          url: null,
          thumbnail: null,
          mime_type: null,
          duration_ms: null,
          alt_text: null
        }));
    }
    if (sql.startsWith('SELECT `id`, `display_name` FROM `mica_accounts` WHERE `id` IN')) {
      return w.accounts
        .filter((a) => params.includes(a.id))
        .map((a) => ({ id: a.id, display_name: a.display_name ?? null }));
    }
    if (sql.includes('FROM `mica_accounts` WHERE `id` IN')) {
      return w.accounts.filter((a) => params.includes(a.id)).map((a) => ({ ...a }));
    }
    if (sql.includes('FROM `mica_spark` s JOIN `mica_accounts` a') && sql.includes('s.`id` IN')) {
      const count = (sql.match(/s\.`id` IN \(([^)]*)\)/)?.[1].match(/\?/g) ?? []).length;
      const ids = params.slice(0, count);
      // The viewer's block clauses, honoured only where the statement carries them.
      const viewerBlocks = sql.includes(
        'b.`blocker_account_id` = ? AND b.`blocked_account_id` = s.`account_id`'
      );
      const viewer = params[count];
      return w.profiles
        .filter(
          (p) =>
            ids.includes(p.id) &&
            activeIf(sql, 's.', p) &&
            onActiveAccount(sql, p) &&
            !(viewerBlocks && (blocked(viewer, p.account_id) || blocked(p.account_id, viewer)))
        )
        .map(projectProfile);
    }
    if (sql.includes("WHERE s.`status` = 'active' AND s.`citizenid` <> ?")) {
      const [citizenid, mineId, days, myAccount, myAccount2] = params;
      const hasCursor = sql.includes('s.`id` < ?');
      const cursor = hasCursor ? params[5] : null;
      const limit = params[hasCursor ? 6 : 5];
      // Each exclusion only where the statement carries it, so a dropped clause shows.
      const has = (clause: string) => sql.includes(clause);
      const photoRule = has(
        "JOIN `mica_media` m ON m.`id` = p.`media_id` AND m.`status` = 'active' WHERE p.`profile_id` = s.`id`"
      );
      const swipeRule = has(
        "w.`swiper_profile_id` = ? AND w.`target_profile_id` = s.`id` AND (w.`kind` = 'like' OR w.`created_at` > NOW() - INTERVAL ? DAY)"
      );
      const mineBlocks = has(
        'b.`blocker_account_id` = ? AND b.`blocked_account_id` = s.`account_id`'
      );
      const theirBlocks = has(
        'b.`blocker_account_id` = s.`account_id` AND b.`blocked_account_id` = ?'
      );
      return w.profiles
        .filter(
          (p) =>
            p.status === 'active' &&
            onActiveAccount(sql, p) &&
            p.citizenid !== citizenid &&
            (!photoRule || hasActivePhoto(p.id)) &&
            !(
              swipeRule &&
              w.swipes.some(
                (s) =>
                  s.swiper_profile_id === mineId &&
                  s.target_profile_id === p.id &&
                  (s.kind === 'like' || (s.age_days ?? 0) < days)
              )
            ) &&
            !(mineBlocks && blocked(myAccount, p.account_id)) &&
            !(theirBlocks && blocked(p.account_id, myAccount2)) &&
            (cursor === null || p.id < cursor)
        )
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
        .map(projectProfile);
    }
    if (sql.includes('FROM `mica_spark_matches` m JOIN `mica_spark` pa')) {
      const [a, b] = params;
      return w.matches
        .filter((m) => {
          const pa = profileById(m.profile_a);
          const pb = profileById(m.profile_b);
          return (
            pa &&
            pb &&
            ((pa.account_id === a && pb.account_id === b) ||
              (pa.account_id === b && pb.account_id === a))
          );
        })
        .map((m) => ({ ...m, a_account: profileById(m.profile_a)!.account_id }));
    }
    if (sql.startsWith('INSERT INTO `mica_spark_swipes`')) {
      const [swiper, target, kind] = params;
      const existing = w.swipes.find(
        (s) => s.swiper_profile_id === swiper && s.target_profile_id === target
      );
      if (!existing) {
        w.swipes.push({
          id: nextId(),
          swiper_profile_id: swiper,
          target_profile_id: target,
          kind,
          age_days: 0
        });
      } else if (existing.kind !== 'like') {
        existing.kind = kind;
        existing.age_days = 0;
      }
      return { affectedRows: 1 };
    }
    if (sql.includes('FROM `mica_spark_matches` WHERE `profile_a` = ? OR `profile_b` = ?')) {
      const rows = w.matches
        .filter((m) => m.profile_a === params[0] || m.profile_b === params[1])
        .sort((a, b) => b.id - a.id)
        .map((m) => ({ ...m }));
      return sql.includes('LIMIT ?') ? rows.slice(0, params[2]) : rows;
    }
    if (
      sql.startsWith('SELECT `id`, `account_id`, `status` FROM `mica_spark` WHERE `citizenid` = ?')
    ) {
      return w.profiles
        .filter((p) => p.citizenid === params[0])
        .map((p) => ({ id: p.id, account_id: p.account_id, status: p.status }));
    }
    if (sql.includes("FROM `mica_spark_swipes` WHERE `kind` = 'pass' AND `created_at` <")) {
      return w.swipes
        .filter((s) => s.kind === 'pass' && (s.age_days ?? 0) > params[0])
        .map((s) => ({ id: s.id }));
    }
    if (sql.startsWith('DELETE FROM `mica_spark_swipes` WHERE `id` IN')) {
      const days = params[params.length - 1];
      const ids = params.slice(0, -1);
      const before = w.swipes.length;
      w.swipes = w.swipes.filter(
        (s) => !(ids.includes(s.id) && s.kind === 'pass' && (s.age_days ?? 0) > days)
      );
      return { affectedRows: before - w.swipes.length };
    }
    return [];
  });

  dbMock.update.mockImplementation(async (raw: string, params: any[] = []) => {
    const sql = one(raw);
    if (sql.startsWith('UPDATE `mica_accounts` SET')) {
      const set = sql.slice(0, sql.indexOf(' WHERE '));
      const columns = [...set.matchAll(/`(\w+)` = \?/g)].map((m) => m[1]).slice(0);
      const values = params.slice(0, columns.length);
      const [id, citizenid] = params.slice(columns.length);
      const a = w.accounts.find((x) => x.id === id && x.citizenid === citizenid);
      if (!a || (sql.includes("`status` != 'moderated'") && a.status === 'moderated')) return false;
      columns.forEach((column, i) => (a[column] = values[i]));
      return true;
    }
    if (sql.startsWith('UPDATE `mica_spark` SET `age` = ?')) {
      const [age, bio, lookingFor, id, citizenid] = params;
      const p = w.profiles.find(
        (x) => x.id === id && x.citizenid === citizenid && x.status === 'active'
      );
      if (!p) return false;
      Object.assign(p, { age, bio, looking_for: lookingFor });
      return true;
    }
    if (sql.startsWith("UPDATE `mica_spark` SET `status` = 'deleted'")) {
      const p = w.profiles.find(
        (x) => x.id === params[0] && x.citizenid === params[1] && x.status === 'active'
      );
      if (!p) return false;
      p.status = 'deleted';
      return true;
    }
    if (
      sql.startsWith('DELETE FROM `mica_spark_photos` WHERE `profile_id` = ? AND `citizenid` = ?')
    ) {
      const before = w.photos.length;
      w.photos = w.photos.filter((x) => !(x.profile_id === params[0] && x.citizenid === params[1]));
      return before !== w.photos.length;
    }
    if (sql.startsWith('DELETE FROM `mica_spark_matches` WHERE `id` = ? AND')) {
      const before = w.matches.length;
      w.matches = w.matches.filter(
        (m) => !(m.id === params[0] && (m.profile_a === params[1] || m.profile_b === params[2]))
      );
      return before !== w.matches.length;
    }
    if (sql.startsWith('DELETE FROM `mica_spark_swipes` WHERE `swiper_profile_id` = ? OR')) {
      const before = w.swipes.length;
      w.swipes = w.swipes.filter(
        (s) => s.swiper_profile_id !== params[0] && s.target_profile_id !== params[1]
      );
      return before !== w.swipes.length;
    }
    return false;
  });

  dbMock.insert.mockImplementation(async (raw: string, params: any[] = []) => {
    const sql = one(raw);
    if (sql.startsWith('INSERT INTO `mica_accounts`')) {
      const columns = [...sql.slice(0, sql.indexOf(')')).matchAll(/`(\w+)`/g)]
        .map((m) => m[1])
        .filter((c) => c !== 'mica_accounts');
      const row: Row = {};
      if (w.accountInsertFails) {
        const { error, run } = w.accountInsertFails;
        w.accountInsertFails = undefined;
        run();
        throw error;
      }
      columns.forEach((c, i) => (row[c] = params[i]));
      const [citizenid, app, limit] = params.slice(columns.length);
      const held = w.accounts.filter(
        (a) => a.citizenid === citizenid && a.app === app && a.status === 'active'
      ).length;
      if (held >= limit) return 0;
      if (w.accounts.some((a) => a.app === row.app && a.handle === row.handle)) {
        throw duplicate('app_handle');
      }
      const id = nextId();
      w.accounts.push({ id, status: 'active', ...row });
      return id;
    }
    if (sql.startsWith('INSERT INTO `mica_spark` (')) {
      const [citizenid, accountId, age, bio, lookingFor] = params;
      if (w.profiles.some((p) => p.citizenid === citizenid && p.status !== 'deleted')) {
        throw duplicate('live_citizen');
      }
      const id = nextId();
      w.profiles.push({
        id,
        citizenid,
        account_id: accountId,
        age,
        bio,
        looking_for: lookingFor,
        status: 'active'
      });
      return id;
    }
    if (sql.startsWith('INSERT INTO `mica_spark_photos`')) {
      for (let i = 0; i < params.length; i += 4) {
        w.photos.push({
          id: nextId(),
          profile_id: params[i],
          citizenid: params[i + 1],
          media_id: params[i + 2],
          position: params[i + 3]
        });
      }
      return w.nextId;
    }
    if (sql.startsWith('INSERT INTO `mica_spark_matches`')) {
      if (w.matches.some((m) => m.profile_a === params[0] && m.profile_b === params[1])) {
        throw duplicate('pair');
      }
      const id = nextId();
      w.matches.push({ id, profile_a: params[0], profile_b: params[1], created_at: 'now' });
      const during = w.duringMatchInsert;
      w.duringMatchInsert = undefined;
      during?.();
      return id;
    }
    if (sql.startsWith('INSERT INTO `mica_account_blocks`')) {
      if (blocked(params[0], params[1])) throw duplicate('blocker_blocked');
      w.blocks.push([params[0], params[1]]);
      return nextId();
    }
    if (sql.startsWith('INSERT INTO `mica_blabber_dms`')) {
      const id = nextId();
      w.dms.push({ id });
      return id;
    }
    return 0;
  });

  // One transaction: each statement through the same world, as one unit.
  dbMock.transaction.mockImplementation(
    async (queries: { query: string; params?: unknown[] }[]) => {
      for (const { query, params } of queries) {
        const sql = one(query);
        if (sql.startsWith('INSERT')) await dbMock.insert(query, params ?? []);
        else await dbMock.update(query, params ?? []);
      }
      return true;
    }
  );
};

const call = async (event: string, data: unknown, citizenid = 'CIT_A') => {
  const handler = handlers.get(`mica:server:${event}`);
  if (!handler) throw new Error(`no handler for ${event}`);
  bridge.current = citizenid;
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls[0]?.[3];
};

const GONE = 'That profile is gone.';

/** A world of players: an account, a profile with one active photo each. */
const seed = (
  players: { cid: string; account: number; profile?: number; status?: string; acct?: string }[]
) => {
  for (const p of players) {
    w.accounts.push({
      id: p.account,
      citizenid: p.cid,
      app: SPARK_APP,
      handle: `h${p.account}`,
      display_name: `Name ${p.account}`,
      status: p.acct ?? 'active'
    });
    if (p.profile === undefined) continue;
    const mediaId = 900 + p.profile;
    w.media.push({ id: mediaId, citizenid: p.cid, status: 'active', kind: 'photo', data: 'img' });
    w.profiles.push({
      id: p.profile,
      citizenid: p.cid,
      account_id: p.account,
      age: 30,
      bio: `bio ${p.profile}`,
      looking_for: null,
      status: p.status ?? 'active'
    });
    w.photos.push({
      id: 500 + p.profile,
      profile_id: p.profile,
      citizenid: p.cid,
      media_id: mediaId,
      position: 0
    });
  }
};

const ME = { cid: 'CIT_A', account: 1, profile: 10 };
const BEA = { cid: 'CIT_B', account: 2, profile: 20 };

const citizenIdsIn = (value: unknown) => JSON.stringify(value).match(/CIT_[A-Z]/g) ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  __resetSparkSweep();
  installTestPhone();
  pushes.length = 0;
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
  (globalThis as any).IsPlayerAceAllowed = () => false;
  w = {
    accounts: [],
    profiles: [],
    photos: [],
    media: [],
    swipes: [],
    matches: [],
    blocks: [],
    dms: [],
    nextId: 1000
  };
  install();
});

describe('the declaration', () => {
  it('is reportable, owner/owner, with every generic action off', () => {
    expect(REPORTABLE()['mica_spark']).toMatchObject({ label: 'Dating profile' });
    expect(spark.resolved.table).toBe('mica_spark');
    for (const action of ['get', 'create', 'update', 'delete']) {
      expect(handlers.has(`mica:server:spark:${action}`), action).toBe(false);
    }
  });

  it('registers the one-unlisted-account policy for spark at import', async () => {
    expect(() => registerAccountAppPolicy('spark', { maxPerCitizen: 1 })).toThrow(
      /already has an account policy/
    );
    const reply = await call('accounts:mine', { app: 'spark' });
    expect(reply.limit).toBe(1);
  });
});

describe('save', () => {
  const photo = (id: number, cid = 'CIT_A', status = 'active') =>
    w.media.push({ id, citizenid: cid, status, kind: 'photo', data: 'img' });

  it('makes the one account on the first save, and reuses it on the next', async () => {
    photo(901);
    photo(902);
    const first = await call('spark:save', {
      display_name: '  Ada ',
      age: 30,
      bio: 'Hi',
      photos: [{ photo_id: 901 }]
    });
    expect(first.error).toBeUndefined();
    expect(w.accounts).toHaveLength(1);
    expect(w.accounts[0]).toMatchObject({ citizenid: 'CIT_A', app: 'spark', display_name: 'Ada' });
    expect(w.accounts[0].handle).toMatch(/^[a-z0-9_]{3,32}$/);
    expect(first).toMatchObject({ display_name: 'Ada', age: 30, bio: 'Hi', status: 'active' });
    expect(first.photo_ids).toEqual([901]);

    const second = await call('spark:save', {
      display_name: 'Ada L',
      age: 31,
      bio: null,
      looking_for: 'coffee',
      photos: [{ photo_id: 902 }, { photo_id: 901 }]
    });
    expect(second.error).toBeUndefined();
    expect(w.accounts).toHaveLength(1);
    expect(w.profiles).toHaveLength(1);
    expect(second).toMatchObject({
      display_name: 'Ada L',
      age: 31,
      bio: null,
      looking_for: 'coffee'
    });
    expect(second.photo_ids).toEqual([902, 901]);
    expect(second.id).toBe(first.id);
  });

  it('makes one account and one profile when two first saves race', async () => {
    photo(901);
    const body = { display_name: 'Ada', age: 30, photos: [{ photo_id: 901 }] };
    const handler = handlers.get('mica:server:spark:save')!;
    bridge.current = 'CIT_A';
    (globalThis as any).emitNet = vi.fn();
    await Promise.all([handler('cb-1', body), handler('cb-2', body)]);
    const replies = (globalThis.emitNet as any).mock.calls.map((c: any[]) => c[3]);
    expect(replies.filter((r: any) => r?.error)).toEqual([]);
    expect(w.accounts.filter((a) => a.citizenid === 'CIT_A')).toHaveLength(1);
    expect(w.profiles.filter((p) => p.status !== 'deleted')).toHaveLength(1);
  });

  it('refuses when no photo is the caller’s own live one, before writing anything', async () => {
    photo(901, 'CIT_B');
    photo(902, 'CIT_A', 'deleted');
    const reply = await call('spark:save', {
      display_name: 'Ada',
      age: 30,
      photos: [{ photo_id: 901 }, { photo_id: 902 }]
    });
    expect(reply).toMatchObject({ key: 'server.spark.needsPhoto' });
    expect(w.accounts).toHaveLength(0);
    expect(w.profiles).toHaveLength(0);
  });

  it('refuses an age under 18 at the contract', async () => {
    photo(901);
    const reply = await call('spark:save', {
      display_name: 'Ada',
      age: 17,
      photos: [{ photo_id: 901 }]
    });
    expect(reply.error).toBeDefined();
    expect(w.profiles).toHaveLength(0);
  });

  it('refuses a taken-down profile or account, and never makes a second account', async () => {
    photo(901);
    seed([{ ...ME, status: 'moderated' }]);
    const reply = await call('spark:save', {
      display_name: 'Ada',
      age: 30,
      photos: [{ photo_id: 901 }]
    });
    expect(reply).toMatchObject({ key: 'server.spark.takenDown' });

    w.profiles = [];
    w.accounts[0].status = 'moderated';
    const again = await call('spark:save', {
      display_name: 'Ada',
      age: 30,
      photos: [{ photo_id: 901 }]
    });
    expect(again).toMatchObject({ key: 'server.spark.takenDown' });
    expect(w.accounts).toHaveLength(1);
  });

  it('makes a new profile row after a remove, on the same account', async () => {
    seed([ME]);
    expect(await call('spark:remove', {})).toBe(true);
    const reply = await call('spark:save', {
      display_name: 'Ada',
      age: 30,
      photos: [{ photo_id: 910 }]
    });
    expect(reply.error).toBeUndefined();
    expect(reply.id).not.toBe(10);
    expect(reply.account_id).toBe(1);
    expect(w.accounts).toHaveLength(1);
  });
});

describe('the deck', () => {
  const deckIds = async (data: Row = {}) => {
    const reply = await call('spark:deck', data);
    expect(reply.error).toBeUndefined();
    return reply.rows.map((r: Row) => r.id);
  };

  it('is refused without a live profile of the caller’s own', async () => {
    seed([{ cid: 'CIT_A', account: 1 }, BEA]);
    expect(await call('spark:deck', {})).toMatchObject({ key: 'server.spark.needsProfile' });
    w.profiles.push({ id: 10, citizenid: 'CIT_A', account_id: 1, age: 30, status: 'moderated' });
    expect(await call('spark:deck', {})).toMatchObject({ key: 'server.spark.needsProfile' });
  });

  it('shows another live profile, and never the caller’s own', async () => {
    seed([ME, BEA]);
    expect(await deckIds()).toEqual([20]);
  });

  it('leaves out a liked profile for good and a passed one for 14 days', async () => {
    seed([
      ME,
      BEA,
      { cid: 'CIT_C', account: 3, profile: 30 },
      { cid: 'CIT_D', account: 4, profile: 40 }
    ]);
    w.swipes.push(
      { id: 1, swiper_profile_id: 10, target_profile_id: 20, kind: 'like', age_days: 400 },
      {
        id: 2,
        swiper_profile_id: 10,
        target_profile_id: 30,
        kind: 'pass',
        age_days: PASS_DAYS - 1
      },
      { id: 3, swiper_profile_id: 10, target_profile_id: 40, kind: 'pass', age_days: PASS_DAYS + 1 }
    );
    expect(await deckIds()).toEqual([40]);
  });

  it('leaves out a block either way', async () => {
    seed([
      ME,
      BEA,
      { cid: 'CIT_C', account: 3, profile: 30 },
      { cid: 'CIT_D', account: 4, profile: 40 }
    ]);
    w.blocks.push([1, 2], [3, 1]);
    expect(await deckIds()).toEqual([40]);
  });

  it('leaves out a deleted or taken-down profile, one on a taken-down account, and one with no active photo', async () => {
    seed([
      ME,
      { ...BEA, status: 'deleted' },
      { cid: 'CIT_C', account: 3, profile: 30, status: 'moderated' },
      { cid: 'CIT_D', account: 4, profile: 40, acct: 'moderated' },
      { cid: 'CIT_E', account: 5, profile: 50 },
      { cid: 'CIT_F', account: 6, profile: 60 }
    ]);
    w.media.find((m) => m.id === 950)!.status = 'deleted';
    expect(await deckIds()).toEqual([60]);
  });

  it('does not depend on the other person’s swipes', async () => {
    seed([ME, BEA, { cid: 'CIT_C', account: 3, profile: 30 }]);
    const before = await deckIds();
    w.swipes.push(
      { id: 1, swiper_profile_id: 20, target_profile_id: 10, kind: 'like' },
      { id: 2, swiper_profile_id: 30, target_profile_id: 10, kind: 'pass' }
    );
    expect(await deckIds()).toEqual(before);
    expect(before).toEqual([30, 20]);
  });

  it('pages newest first with a probe row', async () => {
    seed([
      ME,
      BEA,
      { cid: 'CIT_C', account: 3, profile: 30 },
      { cid: 'CIT_D', account: 4, profile: 40 }
    ]);
    const first = await call('spark:deck', { limit: 2 });
    expect(first.rows.map((r: Row) => r.id)).toEqual([40, 30]);
    expect(first.nextCursor).toBe(30);
    const second = await call('spark:deck', { limit: 2, cursor: 30 });
    expect(second.rows.map((r: Row) => r.id)).toEqual([20]);
    expect(second.nextCursor).toBeNull();
  });

  it('carries no citizenid, no gallery id, and nothing about swipes or matches', async () => {
    seed([ME, BEA]);
    const reply = await call('spark:deck', {});
    expect(citizenIdsIn(reply)).toEqual([]);
    const [card] = reply.rows;
    expect(Object.keys(card).sort()).toEqual(
      ['account_id', 'age', 'bio', 'display_name', 'id', 'looking_for', 'photos'].sort()
    );
    expect(card.photos).toEqual([{ id: 520, media: expect.not.objectContaining({ id: 920 }) }]);
    expect(JSON.stringify(card)).not.toContain('920');
    expect(card.display_name).toBe('Name 2');
  });
});

describe('swipe and match', () => {
  const like = (profileId: number, cid = 'CIT_A') =>
    call('spark:swipe', { profile_id: profileId, verdict: 'like' }, cid);

  it('makes no match and no push on a first like', async () => {
    seed([ME, BEA]);
    expect(await like(20)).toEqual({ match: null });
    expect(w.matches).toHaveLength(0);
    expect(pushes).toEqual([]);
  });

  it('matches on the second like, pushes both once with no names, and answers with the match', async () => {
    seed([ME, BEA]);
    await like(20);
    const reply = await like(10, 'CIT_B');
    expect(w.matches).toEqual([expect.objectContaining({ profile_a: 10, profile_b: 20 })]);
    expect(reply.match).toMatchObject({ id: w.matches[0].id, profile: { id: 10, account_id: 1 } });
    expect(citizenIdsIn(reply)).toEqual([]);
    expect(pushes).toHaveLength(1);
    const [push] = pushes;
    expect(push.to).toEqual(['CIT_B', 'CIT_A']);
    expect(push.event).toBe('match');
    expect(push.payload).toEqual({ match_id: w.matches[0].id });
    expect(push.options.notify).toEqual({ type: 'info', title: 'Spark', message: 'New match' });
    expect(push.options.deepLink).toBe(`spark?matchId=${w.matches[0].id}`);
    expect(JSON.stringify(push)).not.toMatch(/Name \d/);
  });

  it('makes no match when a pass meets a like', async () => {
    seed([ME, BEA]);
    await like(20);
    expect(await call('spark:swipe', { profile_id: 10, verdict: 'pass' }, 'CIT_B')).toEqual({
      match: null
    });
    expect(w.matches).toHaveLength(0);
  });

  it('turns a pass into a like, and never a like into a pass', async () => {
    seed([ME, BEA]);
    await call('spark:swipe', { profile_id: 20, verdict: 'pass' });
    await like(20);
    expect(w.swipes).toEqual([expect.objectContaining({ kind: 'like' })]);
    await call('spark:swipe', { profile_id: 20, verdict: 'pass' });
    expect(w.swipes).toEqual([expect.objectContaining({ kind: 'like' })]);
  });

  it('reads back the match another request inserted, and leaves the push to it', async () => {
    seed([ME, BEA]);
    w.swipes.push({ id: 1, swiper_profile_id: 20, target_profile_id: 10, kind: 'like' });
    // The other side's request won the insert between this one's like and its own insert.
    w.matches.push({ id: 77, profile_a: 10, profile_b: 20, created_at: 'then' });
    const reply = await like(20);
    expect(reply.match).toMatchObject({ id: 77, profile: { id: 20 } });
    expect(w.matches).toHaveLength(1);
    expect(pushes).toEqual([]);
  });

  it('makes exactly one match and one push when both like at once', async () => {
    seed([ME, BEA]);
    const handler = handlers.get('mica:server:spark:swipe')!;
    (globalThis as any).emitNet = vi.fn();
    bridge.current = 'CIT_A';
    const a = handler('cb-a', { profile_id: 20, verdict: 'like' });
    bridge.current = 'CIT_B';
    const b = handler('cb-b', { profile_id: 10, verdict: 'like' });
    await Promise.all([a, b]);
    expect(w.matches).toHaveLength(1);
    expect(pushes.filter((p) => p.event === 'match')).toHaveLength(1);
  });

  it('answers self, blocked, deleted and missing profiles with one sentence', async () => {
    seed([ME, BEA, { cid: 'CIT_C', account: 3, profile: 30, status: 'deleted' }]);
    w.blocks.push([2, 1]);
    for (const id of [10, 20, 30, 999]) {
      const reply = await call('spark:swipe', { profile_id: id, verdict: 'like' });
      expect(reply, String(id)).toMatchObject({ error: GONE, key: 'server.spark.gone' });
    }
    expect(w.swipes).toHaveLength(0);
  });

  it('lists matches newest first, with the other side’s card and no citizenid', async () => {
    seed([ME, BEA, { cid: 'CIT_C', account: 3, profile: 30 }]);
    w.matches.push(
      { id: 1, profile_a: 10, profile_b: 20, created_at: 'a' },
      { id: 2, profile_a: 10, profile_b: 30, created_at: 'b' }
    );
    const reply = await call('spark:matches', {});
    expect(reply.map((m: Row) => [m.id, m.profile.id])).toEqual([
      [2, 30],
      [1, 20]
    ]);
    expect(citizenIdsIn(reply)).toEqual([]);
  });
});

describe('unmatch, block, remove', () => {
  const matched = () => {
    seed([ME, BEA]);
    w.swipes.push(
      { id: 1, swiper_profile_id: 10, target_profile_id: 20, kind: 'like' },
      { id: 2, swiper_profile_id: 20, target_profile_id: 10, kind: 'like' }
    );
    w.matches.push({ id: 7, profile_a: 10, profile_b: 20, created_at: 'then' });
  };

  it('unmatch deletes the match and the thread, tells the other side silently, and never re-matches', async () => {
    matched();
    expect(await call('spark:unmatch', { match_id: 7 })).toBe(true);
    expect(w.matches).toHaveLength(0);
    expect(deleteThreadSpy).toHaveBeenCalledWith(1, 2);
    expect(pushes).toEqual([
      { to: 'CIT_B', event: 'unmatched', payload: { match_id: 7 }, options: { persist: false } }
    ]);
    expect(w.swipes).toHaveLength(2);

    pushes.length = 0;
    expect(await call('spark:swipe', { profile_id: 10, verdict: 'like' }, 'CIT_B')).toEqual({
      match: null
    });
    expect(w.matches).toHaveLength(0);
    expect(pushes).toEqual([]);
  });

  it('unmatch refuses a match that is not the caller’s', async () => {
    matched();
    seed([{ cid: 'CIT_C', account: 3, profile: 30 }]);
    expect(await call('spark:unmatch', { match_id: 7 }, 'CIT_C')).toBe(false);
    expect(w.matches).toHaveLength(1);
    expect(deleteThreadSpy).not.toHaveBeenCalled();
  });

  it('block ends the match, writes the account block, and the deck leaves them out', async () => {
    matched();
    seed([{ cid: 'CIT_C', account: 3, profile: 30 }]);
    expect(await call('spark:block', { profile_id: 20 })).toBe(true);
    expect(w.blocks).toEqual([[1, 2]]);
    expect(w.matches).toHaveLength(0);
    expect(deleteThreadSpy).toHaveBeenCalledWith(1, 2);
    expect(pushes).toEqual([
      { to: 'CIT_B', event: 'unmatched', payload: { match_id: 7 }, options: { persist: false } }
    ]);
    w.swipes = [];
    const deck = await call('spark:deck', {});
    expect(deck.rows.map((r: Row) => r.id)).toEqual([30]);
  });

  it('remove deletes the profile, every swipe either way, every match and thread, and blanks the account', async () => {
    matched();
    seed([{ cid: 'CIT_C', account: 3, profile: 30 }]);
    w.swipes.push({ id: 3, swiper_profile_id: 30, target_profile_id: 20, kind: 'like' });
    expect(await call('spark:remove', {})).toBe(true);
    expect(profileById(10)!.status).toBe('deleted');
    expect(w.swipes.map((s) => s.id)).toEqual([3]);
    expect(w.matches).toHaveLength(0);
    expect(deleteThreadSpy).toHaveBeenCalledWith(1, 2);
    expect(pushes).toEqual([
      { to: 'CIT_B', event: 'unmatched', payload: { match_id: 7 }, options: { persist: false } }
    ]);
    expect(accountById(1)!.display_name).toBeNull();
    expect(await call('spark:mine', {})).toBeNull();
  });

  it('remove on a taken-down account still removes the profile and ignores the refused scrub', async () => {
    matched();
    accountById(1)!.status = 'moderated';
    expect(await call('spark:remove', {})).toBe(true);
    expect(profileById(10)!.status).toBe('deleted');
    expect(accountById(1)!.display_name).toBe('Name 1');
  });

  it('remove leaves a taken-down profile where the moderator put it', async () => {
    seed([{ ...ME, status: 'moderated' }]);
    await call('spark:remove', {});
    expect(profileById(10)!.status).toBe('moderated');
  });

  it('a self-service delete runs the same removal first, and a failure aborts the purge', async () => {
    matched();
    deleteThreadSpy.mockRejectedValueOnce(new Error('db down'));
    await expect(selfServicePurge('CIT_A')).rejects.toThrow('db down');
    expect(w.matches).toHaveLength(1);
    const purgeDeletes = dbMock.query.mock.calls.filter(([sql]) =>
      /^DELETE FROM `?mica_(?!spark_swipes)/.test(one(String(sql)))
    );
    expect(purgeDeletes).toEqual([]);

    // The profile went first, so the retry has to find its matches on a deleted profile.
    expect(profileById(10)!.status).toBe('deleted');
    await call('spark:remove', {});
    expect(w.matches).toHaveLength(0);
    expect(deleteThreadSpy).toHaveBeenLastCalledWith(1, 2);
  });

  it('remove marks the profile deleted before it forgets anything', async () => {
    matched();
    const seen: string[] = [];
    deleteThreadSpy.mockImplementationOnce(async () => {
      seen.push(profileById(10)!.status);
      return 0;
    });
    await call('spark:remove', {});
    expect(seen).toEqual(['deleted']);
  });

  it('refuses save, swipe and block to a player holding no phone', async () => {
    matched();
    refusePhone();
    for (const [action, data] of [
      ['save', { display_name: 'Ada', age: 30, photos: [{ photo_id: 910 }] }],
      ['swipe', { profile_id: 20, verdict: 'like' }],
      ['block', { profile_id: 20 }]
    ] as const) {
      expect(await call(`spark:${action}`, data), action).toMatchObject(NOT_HELD_REPLY);
    }
  });
});

describe('blocks and removals racing a match (review)', () => {
  const likedBy20 = () => {
    seed([ME, BEA]);
    w.swipes.push({ id: 1, swiper_profile_id: 20, target_profile_id: 10, kind: 'like' });
  };

  it('Matches leaves out a match with a block either way, as accounts:block writes it', async () => {
    seed([ME, BEA, { cid: 'CIT_C', account: 3, profile: 30 }]);
    w.matches.push(
      { id: 1, profile_a: 10, profile_b: 20, created_at: 'a' },
      { id: 2, profile_a: 10, profile_b: 30, created_at: 'b' }
    );
    w.blocks.push([2, 1]);
    expect((await call('spark:matches', {})).map((m: Row) => m.id)).toEqual([2]);
    w.blocks = [[1, 3]];
    expect((await call('spark:matches', {})).map((m: Row) => m.id)).toEqual([1]);
    w.blocks = [];
    expect((await call('spark:matches', {})).map((m: Row) => m.id)).toEqual([2, 1]);
  });

  it('takes back a match whose other side blocked while the like was in flight', async () => {
    likedBy20();
    w.duringMatchInsert = () => w.blocks.push([2, 1]);
    const reply = await call('spark:swipe', { profile_id: 20, verdict: 'like' });
    expect(reply).toEqual({ match: null });
    expect(w.matches).toHaveLength(0);
    expect(deleteThreadSpy).toHaveBeenCalledWith(1, 2);
    expect(pushes).toEqual([]);
  });

  it('takes back a match whose other side removed their profile while the like was in flight', async () => {
    likedBy20();
    w.duringMatchInsert = () => {
      profileById(20)!.status = 'deleted';
    };
    const reply = await call('spark:swipe', { profile_id: 20, verdict: 'like' });
    expect(reply).toEqual({ match: null });
    expect(w.matches).toHaveLength(0);
    expect(pushes).toEqual([]);
  });

  it('keeps and announces a match nothing raced', async () => {
    likedBy20();
    const reply = await call('spark:swipe', { profile_id: 20, verdict: 'like' });
    expect(reply.match).toMatchObject({ profile: { id: 20 } });
    expect(pushes.map((p) => p.event)).toEqual(['match']);
  });

  it('a Spark block writes the block before it looks for the match', async () => {
    seed([ME, BEA]);
    w.matches.push({ id: 7, profile_a: 10, profile_b: 20, created_at: 'then' });
    await call('spark:block', { profile_id: 20 });
    const order = [
      ...dbMock.insert.mock.calls.map((c, i) => ({
        sql: one(String(c[0])),
        at: dbMock.insert.mock.invocationCallOrder[i]
      })),
      ...dbMock.single.mock.calls.map((c, i) => ({
        sql: one(String(c[0])),
        at: dbMock.single.mock.invocationCallOrder[i]
      }))
    ].sort((a, b) => a.at - b.at);
    const blockAt = order.findIndex((o) => o.sql.startsWith('INSERT INTO `mica_account_blocks`'));
    const matchAt = order.findIndex((o) =>
      o.sql.includes('FROM `mica_spark_matches` WHERE `profile_a` = ? AND `profile_b` = ?')
    );
    expect(blockAt).toBeGreaterThanOrEqual(0);
    expect(matchAt).toBeGreaterThan(blockAt);
    expect(w.matches).toHaveLength(0);
  });
});

describe('a block made through accounts:block', () => {
  const accountsBlock = (blocker: number, target: number, cid: string) =>
    call(
      'accounts:block',
      { app: 'spark', blocker_account_id: blocker, blocked_account_id: target },
      cid
    );

  const matched = () => {
    seed([ME, BEA, { cid: 'CIT_C', account: 3, profile: 30 }]);
    w.matches.push(
      { id: 7, profile_a: 10, profile_b: 20, created_at: 'then' },
      { id: 8, profile_a: 10, profile_b: 30, created_at: 'then' }
    );
  };

  it('ends that match and its thread as Spark’s own block does, and tells the blocked side silently', async () => {
    matched();
    expect(await accountsBlock(1, 2, 'CIT_A')).toBe(true);
    expect(w.blocks).toEqual([[1, 2]]);
    expect(w.matches.map((m) => m.id)).toEqual([8]);
    expect(deleteThreadSpy).toHaveBeenCalledTimes(1);
    expect(deleteThreadSpy).toHaveBeenCalledWith(1, 2);
    expect(pushes).toEqual([
      { to: 'CIT_B', event: 'unmatched', payload: { match_id: 7 }, options: { persist: false } }
    ]);
  });

  it('ends it from the other side too: the blocker holds the higher profile id', async () => {
    matched();
    expect(await accountsBlock(2, 1, 'CIT_B')).toBe(true);
    expect(w.matches.map((m) => m.id)).toEqual([8]);
    expect(deleteThreadSpy).toHaveBeenCalledWith(2, 1);
    expect(pushes).toEqual([
      { to: 'CIT_A', event: 'unmatched', payload: { match_id: 7 }, options: { persist: false } }
    ]);
  });

  it('is a no-op on a block that already stood and a match already gone', async () => {
    matched();
    await accountsBlock(1, 2, 'CIT_A');
    deleteThreadSpy.mockClear();
    pushes.length = 0;
    expect(await accountsBlock(1, 2, 'CIT_A')).toBe(true);
    expect(w.blocks).toEqual([[1, 2]]);
    expect(w.matches.map((m) => m.id)).toEqual([8]);
    expect(deleteThreadSpy).not.toHaveBeenCalled();
    expect(pushes).toEqual([]);
  });

  it('leaves the match gone after an unblock, so the pair does not come back', async () => {
    matched();
    await accountsBlock(1, 2, 'CIT_A');
    w.blocks = [];
    const reply = await call('spark:matches', {});
    expect(reply.map((m: Row) => m.id)).toEqual([8]);
  });
});

describe('the account and the photo set (review)', () => {
  it('retries a first save whose account insert deadlocked against a racing save', async () => {
    w.media.push({ id: 901, citizenid: 'CIT_A', status: 'active', kind: 'photo', data: 'img' });
    w.accountInsertFails = {
      error: new Error('Deadlock found when trying to get lock; try restarting transaction'),
      run: () =>
        w.accounts.push({
          id: 1,
          citizenid: 'CIT_A',
          app: SPARK_APP,
          handle: 'sp_other',
          display_name: 'Ada',
          status: 'active'
        })
    };
    const reply = await call('spark:save', {
      display_name: 'Ada',
      age: 30,
      photos: [{ photo_id: 901 }]
    });
    expect(reply.error).toBeUndefined();
    expect(reply.account_id).toBe(1);
    expect(w.accounts).toHaveLength(1);
  });

  it('does not retry an account insert that failed for another reason', async () => {
    w.media.push({ id: 901, citizenid: 'CIT_A', status: 'active', kind: 'photo', data: 'img' });
    w.accountInsertFails = { error: new Error('Lock wait timeout exceeded'), run: () => {} };
    const reply = await call('spark:save', {
      display_name: 'Ada',
      age: 30,
      photos: [{ photo_id: 901 }]
    });
    expect(reply.error).toBeDefined();
    expect(reply.key).not.toBe('server.spark.takenDown');
    expect(w.accounts).toHaveLength(0);
  });

  it('replaces the photo set in one transaction', async () => {
    seed([ME]);
    w.media.push({ id: 902, citizenid: 'CIT_A', status: 'active', kind: 'photo', data: 'img' });
    await call('spark:save', { display_name: 'Ada', age: 30, photos: [{ photo_id: 902 }] });
    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
    const [queries] = dbMock.transaction.mock.calls[0];
    expect(queries.map((q: any) => one(q.query).split(' ').slice(0, 3).join(' '))).toEqual([
      'DELETE FROM `mica_spark_photos`',
      'INSERT INTO `mica_spark_photos`'
    ]);
    expect(w.photos.filter((p) => p.profile_id === 10).map((p) => p.media_id)).toEqual([902]);
  });

  it('shows at most four photos on a card, whatever the table holds', async () => {
    seed([ME, BEA]);
    for (let i = 1; i <= 7; i += 1) {
      w.media.push({ id: 950 + i, citizenid: 'CIT_B', status: 'active', kind: 'photo', data: 'x' });
      w.photos.push({
        id: 600 + i,
        profile_id: 20,
        citizenid: 'CIT_B',
        media_id: 950 + i,
        position: i
      });
    }
    const reply = await call('spark:deck', {});
    expect(reply.rows[0].photos).toHaveLength(4);
  });
});

describe('the DM policy', () => {
  const send = (cid = 'CIT_A', from = 1, to = 2) =>
    call('dms:send', { app: 'spark', account_id: from, peer_account_id: to, body: 'hey' }, cid);
  const threadRead = () =>
    dbMock.query.mock.calls.some(([sql]) => String(sql).includes('FROM `mica_blabber_dms`'));

  it('refuses a send and reads an empty thread without a match', async () => {
    seed([ME, BEA]);
    expect(await send()).toMatchObject({ key: 'server.blabberDms.blocked' });
    expect(w.dms).toHaveLength(0);
    const reply = await call('dms:get', { app: 'spark', account_id: 1, peer_account_id: 2 });
    expect(reply).toEqual({ rows: [], nextCursor: null });
    expect(threadRead()).toBe(false);
  });

  it('sends between matched accounts, notifying with no name and no body', async () => {
    seed([ME, BEA]);
    w.matches.push({ id: 7, profile_a: 10, profile_b: 20, created_at: 'then' });
    const reply = await send();
    expect(reply.error).toBeUndefined();
    expect(w.dms).toHaveLength(1);
    const push = pushes.find((p) => p.event === 'dm')!;
    expect(push.to).toBe('CIT_B');
    expect(push.options.notify).toMatchObject({ title: 'Spark', message: 'New message' });
    expect(push.options.deepLink).toBe('spark?accountId=1');
    expect(push.options.body).toBe('');
    expect(JSON.stringify(push.options)).not.toContain('hey');

    await call('dms:get', { app: 'spark', account_id: 1, peer_account_id: 2 });
    expect(threadRead()).toBe(true);
  });

  it('refuses after an unmatch', async () => {
    seed([ME, BEA]);
    w.matches.push({ id: 7, profile_a: 10, profile_b: 20, created_at: 'then' });
    await call('spark:unmatch', { match_id: 7 });
    expect(await send()).toMatchObject({ key: 'server.blabberDms.blocked' });
  });

  it('refuses both ways on a block, match row or not', async () => {
    seed([ME, BEA]);
    w.matches.push({ id: 7, profile_a: 10, profile_b: 20, created_at: 'then' });
    w.blocks.push([2, 1]);
    expect(await send()).toMatchObject({ key: 'server.blabberDms.blocked' });
    const reply = await call('dms:get', { app: 'spark', account_id: 1, peer_account_id: 2 });
    expect(reply).toEqual({ rows: [], nextCursor: null });
  });

  it('refuses when either profile is no longer active', async () => {
    seed([ME, { ...BEA, status: 'deleted' }]);
    w.matches.push({ id: 7, profile_a: 10, profile_b: 20, created_at: 'then' });
    expect(await send()).toMatchObject({ key: 'server.blabberDms.blocked' });
  });
});

describe('the sweep', () => {
  it('forgets passes older than 14 days, and keeps likes and younger passes', async () => {
    w.swipes.push(
      {
        id: 1,
        swiper_profile_id: 10,
        target_profile_id: 20,
        kind: 'pass',
        age_days: PASS_DAYS + 1
      },
      { id: 2, swiper_profile_id: 10, target_profile_id: 30, kind: 'pass', age_days: 1 },
      { id: 3, swiper_profile_id: 10, target_profile_id: 40, kind: 'like', age_days: 400 }
    );
    expect(await sweepSparkPasses()).toBe(1);
    expect(w.swipes.map((s) => s.id)).toEqual([2, 3]);
  });
});
