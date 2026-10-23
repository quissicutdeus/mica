// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Dark Chat (MICA-254): channels joined by code, members known only by a per-channel alias,
 * messages that last `mica_darkchat_retention` hours.
 *
 * `Database` is a small in-memory world answering each statement by its shape, honouring the
 * predicates the statement carries — so a handler that drops `left_at IS NULL` or the owner
 * predicate reaches the rows it would then reach — and a read **projects** only what its SQL
 * selects. Being shape-matched, it proves nothing about MariaDB; `pnpm test:schema` does that.
 */

const { dbMock, handlers, pushes } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured,
    pushes: [] as { to: string | string[]; event: string; payload: any; options: any }[]
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

import {
  CODE_ALPHABET,
  HANDLE_LENGTH,
  JOIN_FAILURES,
  JOIN_WINDOW_MS,
  __resetDarkchatJoinLimits,
  __setDarkchatClock,
  aliasKey,
  generateCode,
  normalizeCode
} from '../services/Darkchat';
import {
  __resetDarkchatRetention,
  __resetDarkchatSweep,
  darkchatMessages,
  retentionHours,
  sweepDarkchat
} from '../services/DarkchatMessages';
import '../services/Reports';
import { buildExport, selfServicePurge } from '../services/Privacy';
import { installTestPhone } from './phoneStub';
import { callAsResource } from './invokingResource';
import { __resetRateLimits } from '../lib/rateLimit';
import { __resetExportRateLimits, publishedExport } from '../lib/exports';
import { REPORTABLE } from '../lib/moderation';

type Row = Record<string, any>;

interface World {
  channels: Row[];
  members: Row[];
  messages: Row[];
  reports: Row[];
  nextId: number;
}

let w: World;

const one = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const duplicate = (key: string) =>
  new Error(`Duplicate entry 'x' for key '${key}'`) as Error & { code?: string };

/** The live member row (`left_at` NULL) of a citizen in a channel. */
const liveOf = (channel: unknown, citizenid: unknown) =>
  w.members.find((m) => m.channel_id === channel && m.citizenid === citizenid && !m.left_at);

const channelById = (id: unknown) => w.channels.find((c) => c.id === id);

/**
 * The blind indexes the server writes beside a sealed value (MICA-432), in their no-key form —
 * this suite loads no content key — or the ones a row was written with.
 */
const codeIndexOf = (c: Row) => c.code_index ?? `plain:${c.code}`;
const aliasIndexOf = (m: Row) => m.alias_index ?? `plain:${aliasKey(m.alias)}`;
const handleIndexOf = (m: Row) => m.handle_index ?? `plain:${m.handle}`;

/** A message is inside the window when it is younger than the bound number of hours. */
const inside = (m: Row, hours: unknown) => (m.age_hours ?? 0) < Number(hours);

const install = () => {
  dbMock.single.mockImplementation(async (raw: string, params: unknown[] = []) => {
    const sql = one(raw);
    if (
      sql.startsWith(
        'SELECT m.`id`, m.`citizenid`, m.`channel_id`, m.`alias`, m.`handle` FROM `mica_darkchat_members` m JOIN'
      )
    ) {
      const [channel, citizenid] = params;
      // Honoured, not assumed: a read that drops it reaches a member who has left.
      const live = sql.includes('m.`left_at` IS NULL');
      const member = w.members.find(
        (m) => m.channel_id === channel && m.citizenid === citizenid && (!live || !m.left_at)
      );
      return member && channelById(channel)?.status === 'active'
        ? {
            id: member.id,
            citizenid: member.citizenid,
            channel_id: member.channel_id,
            alias: member.alias,
            handle: member.handle
          }
        : null;
    }
    if (sql.includes('`alias_key` IN (')) {
      const [channel, ...candidates] = params as [number, ...string[]];
      return w.members.some(
        (m) => m.channel_id === channel && !m.left_at && candidates.includes(aliasIndexOf(m))
      )
        ? { 1: 1 }
        : null;
    }
    if (sql.includes("`status` = 'removed'") && sql.includes('FROM `mica_darkchat_members`')) {
      const [channel, citizenid] = params;
      return w.members.some(
        (m) => m.channel_id === channel && m.citizenid === citizenid && m.status === 'removed'
      )
        ? { 1: 1 }
        : null;
    }
    if (sql.startsWith('SELECT 1 FROM `mica_darkchat_members` WHERE `channel_id` = ?')) {
      // `isMember` and the owner-is-live check: both carry `left_at IS NULL`.
      const [channel, citizenid] = params;
      const live = sql.includes('`left_at` IS NULL');
      return w.members.some(
        (m) =>
          m.channel_id === channel && m.citizenid === citizenid && (!live || m.left_at === null)
      )
        ? { 1: 1 }
        : null;
    }
    if (sql.includes('AS is_owner FROM `mica_darkchat` WHERE `code_index` IN (')) {
      const [citizenid, ...candidates] = params;
      const found = w.channels.find(
        (c) => candidates.includes(codeIndexOf(c)) && c.status === 'active'
      );
      return found
        ? {
            id: found.id,
            seal_key: found.seal_key,
            name: found.name,
            code: found.code,
            is_owner: found.citizenid === citizenid ? 1 : 0
          }
        : null;
    }
    if (sql.startsWith('SELECT `id`, `citizenid` FROM `mica_darkchat` WHERE `code_index` IN (')) {
      const found = w.channels.find(
        (c) => params.includes(codeIndexOf(c)) && c.status === 'active'
      );
      return found ? { id: found.id, citizenid: found.citizenid } : null;
    }
    if (sql.startsWith('SELECT `seal_key`, `code` FROM `mica_darkchat` WHERE `id` = ?')) {
      const c = channelById(params[0]);
      return c && c.citizenid === params[1] && c.status === 'active'
        ? { seal_key: c.seal_key, code: c.code }
        : null;
    }
    if (
      sql.startsWith(
        'SELECT mem.`citizenid`, mem.`channel_id`, mem.`alias` FROM `mica_darkchat_messages` msg'
      )
    ) {
      const [citizenid, id] = params;
      const m = w.messages.find((x) => x.id === id);
      const member = m ? liveOf(m.channel_id, citizenid) : undefined;
      return member
        ? { citizenid: member.citizenid, channel_id: member.channel_id, alias: member.alias }
        : null;
    }
    if (sql.startsWith("SELECT 1 FROM `mica_darkchat` WHERE `id` = ? AND `status` = 'active'")) {
      return channelById(params[0])?.status === 'active' ? { 1: 1 } : null;
    }
    if (sql.startsWith('SELECT 1 FROM `mica_darkchat` WHERE `id` = ? AND `citizenid` = ?')) {
      const found = channelById(params[0]);
      return found && found.citizenid === params[1] && found.status === 'active' ? { 1: 1 } : null;
    }
    if (sql.includes('AS preview')) {
      const m = w.messages.find((x) => x.id === params[0]);
      return m
        ? { citizenid: m.citizenid, status: m.status, preview: m.body, channel_id: m.channel_id }
        : null;
    }
    if (sql.includes('FROM `mica_darkchat_messages` WHERE `id` = ?')) {
      // Reports' visibility read.
      const [id, hours] = params;
      const m = w.messages.find((x) => x.id === id);
      return m && m.status === 'active' && m.author_member_id !== null && inside(m, hours)
        ? { channel_id: m.channel_id }
        : null;
    }
    return null;
  });

  dbMock.scalar.mockImplementation(async (raw: string, params: unknown[] = []) => {
    const sql = one(raw);
    if (
      sql.startsWith(
        "SELECT `citizenid` FROM `mica_darkchat` WHERE `id` = ? AND `status` = 'active'"
      )
    ) {
      const c = channelById(params[0]);
      return c && c.status === 'active' ? c.citizenid : null;
    }
    if (sql.includes('ORDER BY `id` LIMIT 1') && sql.includes('FROM `mica_darkchat_members`')) {
      const heir = w.members
        .filter((m) => m.channel_id === params[0] && !m.left_at)
        .sort((a, b) => a.id - b.id)[0];
      return heir ? heir.citizenid : null;
    }
    if (
      sql.startsWith('SELECT `seal_key` FROM `mica_darkchat` WHERE `id` = ? AND `citizenid` = ?')
    ) {
      const c = channelById(params[0]);
      return c && c.citizenid === params[1] && c.status === 'active' ? (c.seal_key ?? null) : null;
    }
    if (
      sql.startsWith('SELECT `citizenid` FROM `mica_darkchat_members` WHERE `handle_index` IN (')
    ) {
      const candidates = params.slice(0, -2);
      const [channel, notMe] = params.slice(-2);
      const m = w.members.find(
        (x) => candidates.includes(handleIndexOf(x)) && x.channel_id === channel && !x.left_at
      );
      return m && m.citizenid !== notMe ? m.citizenid : null;
    }
    return null;
  });

  dbMock.insert.mockImplementation(async (raw: string, params: unknown[] = []) => {
    const sql = one(raw);
    const id = w.nextId++;
    if (sql.startsWith('INSERT INTO `mica_darkchat` ')) {
      const [citizenid, seal_key, name, code, code_index] = params;
      if (w.channels.some((c) => codeIndexOf(c) === code_index)) {
        throw duplicate('mica_darkchat.code_index');
      }
      w.channels.push({ id, citizenid, seal_key, name, code, code_index, status: 'active' });
      return id;
    }
    if (sql.startsWith('INSERT INTO `mica_darkchat_members`')) {
      const [channel, citizenid, alias, handle, alias_index, handle_index] = params as [
        number,
        string,
        string,
        string,
        string,
        string
      ];
      if (liveOf(channel, citizenid)) throw duplicate('mica_darkchat_members.channel_citizen');
      if (w.members.some((m) => handleIndexOf(m) === handle_index))
        throw duplicate('mica_darkchat_members.handle_index');
      if (
        w.members.some(
          (m) => m.channel_id === channel && !m.left_at && aliasIndexOf(m) === alias_index
        )
      ) {
        throw duplicate('mica_darkchat_members.channel_alias');
      }
      w.members.push({
        id,
        channel_id: channel,
        citizenid,
        alias,
        handle,
        alias_index,
        handle_index,
        status: 'active',
        left_at: null
      });
      return id;
    }
    if (sql.startsWith('INSERT INTO `mica_darkchat_messages`')) {
      const columns = /\(([^)]*)\) VALUES/
        .exec(sql)![1]
        .split(',')
        .map((c) => c.trim().replace(/`/g, ''));
      const row: Row = {
        id,
        status: 'active',
        author_member_id: null,
        bot_alias: null,
        age_hours: 0
      };
      columns.forEach((c, i) => (row[c] = params[i]));
      w.messages.push(row);
      return id;
    }
    if (sql.startsWith('INSERT INTO `mica_reports`')) {
      const columns = /\(([^)]*)\) VALUES/
        .exec(sql)![1]
        .split(',')
        .map((c) => c.trim().replace(/`/g, ''));
      const row: Row = { id };
      columns.forEach((c, i) => (row[c] = params[i]));
      w.reports.push(row);
      return id;
    }
    return id;
  });

  dbMock.update.mockImplementation(async (raw: string, params: unknown[] = []) => {
    const sql = one(raw);
    if (
      sql.startsWith("UPDATE `mica_darkchat_members` SET `status` = 'left'") &&
      sql.includes('WHERE `id` = ?')
    ) {
      // The join race's take-back of the seat it just inserted.
      const m = w.members.find((x) => x.id === params[0] && !x.left_at);
      if (!m) return false;
      Object.assign(m, { status: 'left', left_at: 'now' });
      return true;
    }
    if (sql.startsWith("UPDATE `mica_darkchat_members` SET `status` = 'left'")) {
      const [channel, citizenid] = params;
      const m = liveOf(channel, citizenid);
      if (!m) return false;
      Object.assign(m, { status: 'left', left_at: 'now' });
      return true;
    }
    if (sql.startsWith('UPDATE `mica_darkchat_members` m JOIN `mica_darkchat` c')) {
      // The owner predicate rides the join, and is honoured: no owner, no removal.
      const [owner, ...rest] = params;
      const candidates = rest.slice(0, -2);
      const [channel, notMe] = rest.slice(-2);
      const c = channelById(channel);
      const ownerHeld =
        sql.includes('c.`citizenid` = ?') && c?.citizenid === owner && c?.status === 'active';
      const m = w.members.find(
        (x) => candidates.includes(handleIndexOf(x)) && x.channel_id === channel && !x.left_at
      );
      if (!ownerHeld || !m || m.citizenid === notMe) return false;
      Object.assign(m, { status: 'removed', left_at: 'now' });
      return true;
    }
    if (sql.startsWith('UPDATE `mica_darkchat` SET `citizenid` = ?')) {
      const [heir, id, owner] = params;
      const c = channelById(id);
      if (!c || c.citizenid !== owner || c.status !== 'active') return false;
      c.citizenid = heir;
      return true;
    }
    if (sql.startsWith("UPDATE `mica_darkchat` SET `status` = 'deleted'")) {
      const [id, owner] = params;
      const c = channelById(id);
      if (!c || c.citizenid !== owner) return false;
      c.status = 'deleted';
      return true;
    }
    if (sql.startsWith('UPDATE `mica_darkchat` SET `code` = ?, `code_index` = ?')) {
      const [code, code_index, id, owner] = params;
      const c = channelById(id);
      if (!c || c.citizenid !== owner || c.status !== 'active') return false;
      if (w.channels.some((x) => codeIndexOf(x) === code_index)) {
        throw duplicate('mica_darkchat.code_index');
      }
      Object.assign(c, { code, code_index });
      return true;
    }
    return false;
  });

  dbMock.query.mockImplementation(async (raw: string, params: unknown[] = []) => {
    const sql = one(raw);
    if (sql.startsWith('SELECT DISTINCT `citizenid` FROM `mica_darkchat_members`')) {
      return [
        ...new Set(
          w.members.filter((m) => m.channel_id === params[0] && !m.left_at).map((m) => m.citizenid)
        )
      ].map((citizenid) => ({ citizenid }));
    }
    if (sql.startsWith('SELECT DISTINCT `channel_id` FROM `mica_darkchat_members`')) {
      return [
        ...new Set(
          w.members.filter((m) => m.citizenid === params[0] && !m.left_at).map((m) => m.channel_id)
        )
      ].map((channel_id) => ({ channel_id }));
    }
    if (sql.includes('FROM `mica_darkchat_members` m JOIN `mica_darkchat` c')) {
      return w.members
        .filter(
          (m) =>
            m.citizenid === params[0] &&
            !m.left_at &&
            channelById(m.channel_id)?.status === 'active'
        )
        .map((m) => {
          const c = channelById(m.channel_id)!;
          return {
            id: c.id,
            seal_key: c.seal_key,
            name: c.name,
            citizenid: m.citizenid,
            handle: m.handle,
            alias: m.alias,
            is_owner: c.citizenid === m.citizenid ? 1 : 0
          };
        });
    }
    if (
      sql.startsWith(
        'SELECT `citizenid`, `channel_id`, `handle`, `alias` FROM `mica_darkchat_members`'
      )
    ) {
      // In join order, as the table hands them back: the alias order is the server's own now.
      return w.members
        .filter((m) => m.channel_id === params[0] && !m.left_at)
        .sort((a, b) => a.id - b.id)
        .map((m) => ({
          citizenid: m.citizenid,
          channel_id: m.channel_id,
          handle: m.handle,
          alias: m.alias
        }));
    }
    if (sql.startsWith('SELECT msg.`id`, msg.`citizenid`')) {
      const withCursor = sql.includes('msg.`id` < ?');
      const [channel, hours, ...rest] = params;
      const cursor = withCursor ? rest[0] : null;
      const limit = Number(rest[rest.length - 1]);
      return w.messages
        .filter(
          (m) =>
            m.channel_id === channel &&
            m.status === 'active' &&
            inside(m, hours) &&
            (cursor === null || m.id < (cursor as number))
        )
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
        .map((m) => ({
          id: m.id,
          citizenid: m.citizenid,
          channel_id: m.channel_id,
          author_member_id: m.author_member_id,
          bot_alias: m.bot_alias,
          body: m.body,
          created_at: m.created_at ?? '2026-10-17 12:00:00',
          member_alias: w.members.find((x) => x.id === m.author_member_id)?.alias ?? null,
          member_handle: sql.includes('AS member_handle')
            ? (w.members.find((x) => x.id === m.author_member_id)?.handle ?? null)
            : undefined,
          member_citizenid: sql.includes('AS member_citizenid')
            ? (w.members.find((x) => x.id === m.author_member_id)?.citizenid ?? null)
            : undefined
        }));
    }
    return [];
  });
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

const citizenIdsIn = (value: unknown) => JSON.stringify(value).match(/CIT_[A-Z]/g) ?? [];

/** A drained microtask queue, so a push that is never awaited has run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let clock = 1_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  __resetExportRateLimits();
  __resetDarkchatJoinLimits();
  __resetDarkchatRetention();
  __resetDarkchatSweep();
  clock = 1_000_000;
  __setDarkchatClock(() => clock);
  installTestPhone();
  pushes.length = 0;
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
  (globalThis as any).IsPlayerAceAllowed = () => false;
  w = { channels: [], members: [], messages: [], reports: [], nextId: 100 };
  install();
});

afterEach(() => {
  __setDarkchatClock();
});

/** CIT_A opens a channel as `ghost`; answers its id and code. */
const open = async (name = 'Docks', alias = 'ghost') => {
  const reply = await call('darkchat:create', { name, alias });
  expect(reply.error).toBeUndefined();
  return { id: reply.channel.id as number, code: reply.code as string };
};

describe('codes', () => {
  it('draws eight symbols from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateCode();
      expect(code).toHaveLength(8);
      for (const symbol of code) expect(CODE_ALPHABET).toContain(symbol);
    }
    expect(CODE_ALPHABET).not.toMatch(/[01ILO]/);
  });

  it('reads a code as typed: case-blind, spaces and dashes dropped', () => {
    expect(normalizeCode('abcd-2345')).toBe('ABCD2345');
    expect(normalizeCode(' ab cd 23 45 ')).toBe('ABCD2345');
    expect(normalizeCode('ABCD234O')).toBeNull();
    expect(normalizeCode('ABC')).toBeNull();
  });
});

describe('create and join', () => {
  it('creates a channel the creator owns, and answers the code to them alone', async () => {
    const reply = await call('darkchat:create', { name: 'Docks', alias: 'ghost' });
    expect(reply).toMatchObject({
      channel: { name: 'Docks', my_alias: 'ghost', is_owner: true },
      code: expect.stringMatching(/^[A-Z2-9]{8}$/)
    });
    expect(w.channels[0].citizenid).toBe('CIT_A');

    const joined = await call('darkchat:join', { code: reply.code, alias: 'crow' }, 'CIT_B');
    expect(joined.channel).toMatchObject({
      id: reply.channel.id,
      my_alias: 'crow',
      is_owner: false
    });
    expect(joined.code).toBeUndefined();
  });

  it('draws again when a code is taken', async () => {
    w.channels.push({ id: 1, citizenid: 'CIT_Z', name: 'x', code: 'TAKEN', status: 'active' });
    let first = true;
    const realInsert = dbMock.insert.getMockImplementation()!;
    dbMock.insert.mockImplementation(async (sql: string, params: unknown[]) => {
      if (first && one(sql).startsWith('INSERT INTO `mica_darkchat` ')) {
        first = false;
        throw duplicate('mica_darkchat.code');
      }
      return realInsert(sql, params);
    });
    const reply = await call('darkchat:create', { name: 'Docks', alias: 'ghost' });
    expect(reply.error).toBeUndefined();
    expect(w.channels).toHaveLength(2);
  });

  it('refuses an alias a live member already has, case-blind', async () => {
    const { code } = await open();
    const reply = await call('darkchat:join', { code, alias: 'GHOST' }, 'CIT_B');
    expect(reply.key).toBe('server.darkchat.aliasTaken');
  });

  /**
   * MICA-432: sealed, the alias is compared by `aliasKey`, which folds at least as far as the
   * collation it replaces — so an impersonator gets no new room. The twin: a different alias,
   * however close it looks to a reader, is still a different alias.
   */
  it.each([
    ['an accent', 'Ghöst'],
    ['a sharp s for ss', 'GHOSS'],
    ['a fullwidth form', 'ｇｈｏｓｔ'],
    ['a zero-width space', 'gh\u200Bost'],
    ['trailing spaces', 'ghost   ']
  ])('refuses an alias a live member has, under %s', async (_label, alias) => {
    const { code } = await open('Docks', alias === 'GHOSS' ? 'ghoß' : 'ghost');
    const reply = await call('darkchat:join', { code, alias }, 'CIT_B');
    expect(reply.key).toBe('server.darkchat.aliasTaken');
  });

  it('folds as widely as the old collation, and no further than letters that differ', () => {
    for (const [a, b] of [
      ['Straße', 'STRASSE'],
      ['Æther', 'aether'],
      ['Øre', 'ore'],
      ['Ghöst', 'ghost'],
      ['ﬁre', 'fire']
    ]) {
      expect(aliasKey(a), `${a} / ${b}`).toBe(aliasKey(b));
    }
    expect(aliasKey('Ghost')).not.toBe(aliasKey('Host'));
    expect(aliasKey('Gh0st')).not.toBe(aliasKey('Ghost'));
  });

  it('answers a missing code, a deleted channel and a removal the same way', async () => {
    const { id, code } = await open();
    const missing = await call('darkchat:join', { code: 'ZZZZZZZZ', alias: 'x' }, 'CIT_B');

    await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    const crow = liveOf(id, 'CIT_B')!;
    await call('darkchat:removeMember', { channel_id: id, member_id: crow.handle });
    const removed = await call('darkchat:join', { code, alias: 'crow2' }, 'CIT_B');

    w.channels[0].status = 'deleted';
    const deleted = await call('darkchat:join', { code, alias: 'x' }, 'CIT_C');

    for (const reply of [missing, removed, deleted]) {
      expect(reply).toEqual({ error: 'That code did not work.', key: 'server.darkchat.badCode' });
    }
  });

  it('seats a rejoin as a new member row, never the old one', async () => {
    const { id, code } = await open();
    await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    const first = liveOf(id, 'CIT_B')!.handle;
    await call('darkchat_messages:send', { channel_id: id, body: 'old words' }, 'CIT_B');

    expect(await call('darkchat:leave', { channel_id: id }, 'CIT_B')).toBe(true);
    const again = await call('darkchat:join', { code, alias: 'raven' }, 'CIT_B');
    expect(again.channel.my_member_id).not.toBe(first);
    expect(w.members.filter((m) => m.citizenid === 'CIT_B')).toHaveLength(2);

    // The old line keeps the old alias, and is no longer the rejoined member's own.
    const page = await call('darkchat_messages:list', { channel_id: id }, 'CIT_B');
    expect(page.rows[0]).toMatchObject({ alias: 'crow', mine: false, body: 'old words' });
  });

  it('refuses a removed member forever', async () => {
    const { id, code } = await open();
    await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    const crow = liveOf(id, 'CIT_B')!;
    expect(await call('darkchat:removeMember', { channel_id: id, member_id: crow.handle })).toBe(
      true
    );
    expect(w.members.find((m) => m.id === crow.id)).toMatchObject({ status: 'removed' });

    const reply = await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    expect(reply.key).toBe('server.darkchat.badCode');
    expect(liveOf(id, 'CIT_B')).toBeUndefined();
  });
});

describe('failed joins are limited per citizen', () => {
  it('stops a citizen after ten failures in ten minutes, whatever source they come from', async () => {
    const { code } = await open();
    for (let i = 0; i < JOIN_FAILURES; i += 1) {
      (globalThis as any).source = 10 + i;
      expect((await call('darkchat:join', { code: 'ZZZZZZZZ', alias: 'x' }, 'CIT_B')).key).toBe(
        'server.darkchat.badCode'
      );
      // A reconnect is a new source and a fresh stock limiter; this window does not reset.
      __resetRateLimits();
    }
    // Even the right code is refused now, without a read.
    dbMock.single.mockClear();
    const blocked = await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    expect(blocked.key).toBe('server.darkchat.tooManyCodes');
    expect(dbMock.single).not.toHaveBeenCalled();

    // Somebody else is not.
    expect((await call('darkchat:join', { code, alias: 'owl' }, 'CIT_C')).channel).toBeDefined();

    clock += JOIN_WINDOW_MS;
    expect((await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B')).channel).toBeDefined();
  });

  it('does not count an alias clash, which only a right code reaches', async () => {
    const { code } = await open();
    for (let i = 0; i < JOIN_FAILURES + 2; i += 1) {
      expect((await call('darkchat:join', { code, alias: 'ghost' }, 'CIT_B')).key).toBe(
        'server.darkchat.aliasTaken'
      );
    }
  });
});

describe('ownership', () => {
  it('passes to the longest-standing live member when the owner leaves', async () => {
    const { id, code } = await open();
    await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    await call('darkchat:join', { code, alias: 'owl' }, 'CIT_C');

    expect(await call('darkchat:leave', { channel_id: id })).toBe(true);
    expect(channelById(id)).toMatchObject({ citizenid: 'CIT_B', status: 'active' });

    // The new owner reads the code; the old one and a member cannot.
    expect((await call('darkchat:code', { channel_id: id }, 'CIT_B')).code).toBe(code);
    expect((await call('darkchat:code', { channel_id: id }, 'CIT_A')).key).toBe(
      'server.darkchat.notOwner'
    );
    expect((await call('darkchat:code', { channel_id: id }, 'CIT_C')).key).toBe(
      'server.darkchat.notOwner'
    );
  });

  it('deletes the channel when the last member leaves', async () => {
    const { id, code } = await open();
    await call('darkchat:leave', { channel_id: id });
    expect(channelById(id)!.status).toBe('deleted');
    expect((await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B')).key).toBe(
      'server.darkchat.badCode'
    );
  });

  it('moves ownership again when the heir had left by the time it was handed over', async () => {
    const { id, code } = await open();
    await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    await call('darkchat:join', { code, alias: 'owl' }, 'CIT_C');
    // The race: the channel was handed to CIT_B, who left in the same moment.
    channelById(id)!.citizenid = 'CIT_B';
    liveOf(id, 'CIT_A')!.left_at = 'now';
    expect(await call('darkchat:leave', { channel_id: id }, 'CIT_B')).toBe(true);
    expect(channelById(id)!.citizenid).toBe('CIT_C');
  });

  it('rotates the code, and the old one stops working', async () => {
    const { id, code } = await open();
    const rotated = await call('darkchat:rotateCode', { channel_id: id });
    expect(rotated.code).not.toBe(code);
    expect((await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B')).key).toBe(
      'server.darkchat.badCode'
    );
    expect(
      (await call('darkchat:join', { code: rotated.code, alias: 'crow' }, 'CIT_B')).channel
    ).toBeDefined();
    // Not the owner's to rotate.
    expect((await call('darkchat:rotateCode', { channel_id: id }, 'CIT_B')).key).toBe(
      'server.darkchat.notOwner'
    );
    // MICA-430: audited as changed, once, for the rotation that happened, and with neither
    // code in it — the old code is a credential and is not kept anywhere.
    const audits = dbMock.insert.mock.calls.filter(([sql]) =>
      String(sql).includes('mica_audit_logs')
    );
    expect(audits.map(([, params]) => params)).toEqual([
      [
        'CIT_A',
        'changed',
        'darkchat',
        'rotateCode',
        id,
        'mica_darkchat',
        JSON.stringify({ what: 'join code' })
      ]
    ]);
    expect(JSON.stringify(audits)).not.toContain(code);
    expect(JSON.stringify(audits)).not.toContain(rotated.code);
  });

  it('lets only the owner remove, and never themself', async () => {
    const { id, code } = await open();
    await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    const owner = liveOf(id, 'CIT_A')!;
    const crow = liveOf(id, 'CIT_B')!;
    expect(
      (await call('darkchat:removeMember', { channel_id: id, member_id: owner.handle }, 'CIT_B'))
        .key
    ).toBe('server.darkchat.notOwner');
    expect(await call('darkchat:removeMember', { channel_id: id, member_id: owner.handle })).toBe(
      false
    );
    expect(liveOf(id, 'CIT_A')).toBeDefined();
    expect(await call('darkchat:removeMember', { channel_id: id, member_id: crow.handle })).toBe(
      true
    );
    expect(pushes.find((p) => p.event === 'removed')).toMatchObject({
      to: 'CIT_B',
      payload: { channel_id: id }
    });
  });
});

describe('membership is enforced on every message read and write', () => {
  it('refuses a stranger and a removed member, in list and in send', async () => {
    const { id, code } = await open();
    await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    await call('darkchat:removeMember', { channel_id: id, member_id: liveOf(id, 'CIT_B')!.handle });

    for (const who of ['CIT_B', 'CIT_Z']) {
      expect((await call('darkchat_messages:list', { channel_id: id }, who)).key).toBe(
        'server.darkchat.notMember'
      );
      expect((await call('darkchat_messages:send', { channel_id: id, body: 'hi' }, who)).key).toBe(
        'server.darkchat.notMember'
      );
      expect((await call('darkchat:members', { channel_id: id }, who)).key).toBe(
        'server.darkchat.notMember'
      );
    }
    expect(w.messages).toHaveLength(0);
  });

  it("asks isMember for a live row: the declaration's own predicate refuses a removed member", async () => {
    const { id, code } = await open();
    await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    expect(await darkchatMessages.repo.isMember(id, 'CIT_B')).toBe(true);
    await call('darkchat:removeMember', { channel_id: id, member_id: liveOf(id, 'CIT_B')!.handle });
    expect(await darkchatMessages.repo.isMember(id, 'CIT_B')).toBe(false);
    const sql = one(dbMock.single.mock.calls.at(-1)![0]);
    expect(sql).toContain('`left_at` IS NULL');
  });
});

describe('no citizenid leaves the server', () => {
  it('in any channel, member or message projection, or push', async () => {
    const { id, code } = await open();
    await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    const replies = [
      await call('darkchat:list', {}),
      await call('darkchat:members', { channel_id: id }),
      await call('darkchat_messages:send', { channel_id: id, body: 'meet at nine' }),
      await call('darkchat_messages:list', { channel_id: id }, 'CIT_B'),
      await call('darkchat:join', { code, alias: 'owl' }, 'CIT_C')
    ];
    for (const reply of replies) {
      expect(reply?.error).toBeUndefined();
      expect(citizenIdsIn(reply)).toEqual([]);
    }
    await settle();
    expect(citizenIdsIn(pushes.map((p) => p.payload))).toEqual([]);
  });

  it("marks mine per reader, and a list's members by alias with no owner flag", async () => {
    const { id, code } = await open();
    await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    await call('darkchat_messages:send', { channel_id: id, body: 'hello' });
    expect((await call('darkchat_messages:list', { channel_id: id })).rows[0].mine).toBe(true);
    expect(
      (await call('darkchat_messages:list', { channel_id: id }, 'CIT_B')).rows[0]
    ).toMatchObject({
      mine: false,
      alias: 'ghost',
      bot: false
    });
    const members = await call('darkchat:members', { channel_id: id }, 'CIT_B');
    expect(members).toEqual([
      { id: liveOf(id, 'CIT_B')!.handle, alias: 'crow' },
      { id: liveOf(id, 'CIT_A')!.handle, alias: 'ghost' }
    ]);
  });
});

describe('the push', () => {
  it('tells the other live members with a generic, unstored toast', async () => {
    const { id, code } = await open('The Docks', 'ghost');
    await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    await call('darkchat_messages:send', { channel_id: id, body: 'secret words' });
    await settle();
    const push = pushes.find((p) => p.event === 'message')!;
    expect(push.to).toEqual(['CIT_B']);
    expect(push.options).toEqual({
      notify: { type: 'info', title: 'Dark Chat', message: 'New message' },
      persist: false
    });
    expect(JSON.stringify(push.options)).not.toMatch(/secret|Docks|ghost/);
  });

  it('never fails the write', async () => {
    const { id } = await open();
    dbMock.query.mockImplementationOnce(async () => {
      throw new Error('push lookup exploded');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reply = await call('darkchat_messages:send', { channel_id: id, body: 'still sent' });
    await settle();
    expect(reply).toMatchObject({ body: 'still sent', mine: true });
    expect(w.messages).toHaveLength(1);
    error.mockRestore();
  });
});

describe('the retention window', () => {
  it('filters every page read by the window, bound as hours', async () => {
    const { id } = await open();
    w.messages.push(
      {
        id: 1,
        citizenid: 'CIT_A',
        channel_id: id,
        author_member_id: liveOf(id, 'CIT_A')!.id,
        body: 'old',
        status: 'active',
        age_hours: 30
      },
      {
        id: 2,
        citizenid: 'CIT_A',
        channel_id: id,
        author_member_id: liveOf(id, 'CIT_A')!.id,
        body: 'new',
        status: 'active',
        age_hours: 1
      }
    );
    const page = await call('darkchat_messages:list', { channel_id: id });
    expect(page.rows.map((r: any) => r.body)).toEqual(['new']);
    const [sql, params] = dbMock.query.mock.calls.find((c) => String(c[0]).includes('msg.`body`'))!;
    expect(one(sql)).toContain('msg.`created_at` > NOW() - INTERVAL ? HOUR');
    expect(params[1]).toBe(24);
  });

  it('reads the convar each time, whole hours of at least one, and never off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const set = (value: string) => {
      (globalThis as any).GetConvar = (name: string, f: string) =>
        name === 'mica_darkchat_retention' ? value : f;
    };
    set('6');
    expect(retentionHours()).toBe(6);
    set('0');
    expect(retentionHours()).toBe(24);
    set('off');
    expect(retentionHours()).toBe(24);
    set('1.5');
    expect(retentionHours()).toBe(24);
    set('');
    expect(retentionHours()).toBe(24);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('exports only messages inside the window', async () => {
    (globalThis as any).GetConvar = (name: string, f: string) =>
      name === 'mica_darkchat_retention' ? '6' : f;
    await buildExport('CIT_A');
    const exported = dbMock.query.mock.calls.find((c) =>
      String(c[0]).includes('FROM `mica_darkchat_messages`')
    )!;
    expect(one(exported[0])).toContain(
      // Never what an erase hid (MICA-428), then the window.
      "WHERE `citizenid` = ? AND `status` <> 'erased' AND (`created_at` > NOW() - INTERVAL ? HOUR)"
    );
    expect(exported[1]).toEqual(['CIT_A', 6, 1001]);
    // And no other table is narrowed by it.
    const channels = dbMock.query.mock.calls.find((c) =>
      String(c[0]).includes('FROM `mica_darkchat` ')
    )!;
    expect(channels[1]).toEqual(['CIT_A', 1001]);
  });
});

describe('the sweep', () => {
  it('selects past the window, holds reported and moderated rows, and expires exactly those ids', async () => {
    dbMock.query.mockImplementation(async (sql: string) =>
      one(sql).startsWith('SELECT t.`id`') ? [{ id: 7 }, { id: 8 }] : { affectedRows: 2 }
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await sweepDarkchat()).toBe(2);
    log.mockRestore();

    const [select, expire] = dbMock.query.mock.calls;
    // A pending report holds a line, and so does a takedown standing on it (MICA-426): a reopen
    // has to find the row it restores.
    const hold =
      "NOT EXISTS (SELECT 1 FROM `mica_reports` r WHERE r.`target_table` = ? AND r.`target_id` = %.`id` AND r.`status` = 'active' AND r.`resolution` = 'pending') AND %.`status` <> 'moderated'";
    expect(one(select[0])).toContain(
      "t.`status` = 'active' AND t.`created_at` < NOW() - INTERVAL ? HOUR AND " +
        hold.replaceAll('%', 't')
    );
    expect(select[1]).toEqual([24, 'mica_darkchat_messages']);
    // A status change, never a delete (MICA-428): only an active line moves, and its
    // `updated_at` stays the moment it was last edited.
    expect(one(expire[0])).toBe(
      'UPDATE `mica_darkchat_messages` SET `status` = ?, `updated_at` = `updated_at` ' +
        "WHERE `id` IN (?, ?) AND `status` = 'active' AND `created_at` < NOW() - INTERVAL ? HOUR AND " +
        hold.replaceAll('%', '`mica_darkchat_messages`') +
        ' LIMIT 500'
    );
    expect(expire[1]).toEqual(['expired', 7, 8, 24, 'mica_darkchat_messages']);
    // Members and channels are no longer swept: nothing past the two statements above.
    expect(dbMock.query.mock.calls).toHaveLength(2);
  });

  it('never rejects, and logs only the driver line', async () => {
    dbMock.query.mockRejectedValue(new Error("SELECT ... 'secret'\nConnection lost"));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sweepDarkchat()).toBe(0);
    expect(String(error.mock.calls[0][0])).toBe('[darkchat] sweep failed: Connection lost');
    error.mockRestore();
  });
});

describe('reporting a message', () => {
  const setUp = async () => {
    const { id, code } = await open();
    await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    await call('darkchat_messages:send', { channel_id: id, body: 'bad words' });
    return { id, messageId: w.messages[0].id as number };
  };

  it('is reportable, with the reporter labelled by their alias in the channel', async () => {
    expect(REPORTABLE().mica_darkchat_messages?.reporterLabel).toBeTypeOf('function');
    const { messageId } = await setUp();
    const reply = await call(
      'reports:create',
      { targetTable: 'mica_darkchat_messages', targetId: messageId, category: 'harassment' },
      'CIT_B'
    );
    expect(reply).toMatchObject({ ok: true });
    expect(w.reports[0]).toMatchObject({
      target_table: 'mica_darkchat_messages',
      target_author: 'CIT_A',
      reporter_label: 'crow'
    });
  });

  it('is refused to a non-member, to a removed one, and past the window', async () => {
    const { id, messageId } = await setUp();
    const report = (who: string) =>
      call('reports:create', { targetTable: 'mica_darkchat_messages', targetId: messageId }, who);
    expect((await report('CIT_Z')).key).toBe('server.reports.targetGone');

    w.messages[0].age_hours = 25;
    expect((await report('CIT_B')).key).toBe('server.reports.targetGone');
    w.messages[0].age_hours = 0;

    await call('darkchat:removeMember', { channel_id: id, member_id: liveOf(id, 'CIT_B')!.handle });
    expect((await report('CIT_B')).key).toBe('server.reports.targetGone');
    expect(w.reports).toHaveLength(0);
  });

  it("refuses a script's line, which no member wrote", async () => {
    const { messageId } = await setUp();
    w.messages[0].author_member_id = null;
    w.messages[0].bot_alias = 'Dispatch';
    const reply = await call(
      'reports:create',
      { targetTable: 'mica_darkchat_messages', targetId: messageId },
      'CIT_B'
    );
    expect(reply.key).toBe('server.reports.targetGone');
  });
});

describe('PostToDarkChat', () => {
  const post = (...args: unknown[]) =>
    callAsResource('jobs-script', () => (publishedExport('PostToDarkChat') as Function)(...args));

  it('reads the invoking resource before any await', async () => {
    const { id, code } = await open();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await post(code, 'Dispatch', 'Shift starts at six.');
    expect(result).toMatchObject({ ok: true, value: { messageId: expect.any(Number) } });
    expect(log.mock.calls.some((c) => String(c[0]).includes("'jobs-script' posted"))).toBe(true);
    log.mockRestore();

    const row = w.messages[0];
    expect(row).toMatchObject({
      channel_id: id,
      citizenid: 'CIT_A',
      bot_alias: 'Dispatch',
      author_member_id: null
    });
    const page = await call('darkchat_messages:list', { channel_id: id });
    expect(page.rows[0]).toMatchObject({
      bot: true,
      member_id: null,
      alias: 'Dispatch',
      mine: false
    });
  });

  it('refuses an alias a live member speaks under, case-blind', async () => {
    const { code } = await open();
    const result = await post(code, 'GHOST', 'Trust me.');
    expect(result).toMatchObject({ ok: false, reason: 'invalid_args' });
    expect(w.messages).toHaveLength(0);
  });

  it('refuses a dead code, a deleted channel and bad arguments without writing', async () => {
    const { code } = await open();
    expect(await post('ZZZZZZZZ', 'Dispatch', 'x')).toMatchObject({
      ok: false,
      reason: 'invalid_args'
    });
    expect(await post(code, '', 'x')).toMatchObject({ ok: false, reason: 'invalid_args' });
    expect(await post(code, 'Dispatch', 'x'.repeat(501))).toMatchObject({
      ok: false,
      reason: 'invalid_args'
    });
    w.channels[0].status = 'deleted';
    expect(await post(code, 'Dispatch', 'x')).toMatchObject({ ok: false, reason: 'invalid_args' });
    expect(w.messages).toHaveLength(0);
  });

  it('is limited per invoking resource', async () => {
    const { code } = await open();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let last: any;
    for (let i = 0; i < 31; i += 1) last = await post(code, 'Dispatch', `line ${i}`);
    log.mockRestore();
    expect(last).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(w.messages).toHaveLength(30);
  });
});

describe("a player's own delete", () => {
  it('leaves every channel first, so an owned one passes to its heir', async () => {
    const { id, code } = await open();
    await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    await selfServicePurge('CIT_A').catch(() => undefined);
    expect(liveOf(id, 'CIT_A')).toBeUndefined();
    expect(channelById(id)!.citizenid).toBe('CIT_B');
  });
});

describe('member handles, not row ids (review)', () => {
  const HANDLE = new RegExp(`^[${CODE_ALPHABET}]{${HANDLE_LENGTH}}$`);

  it('carries the handle in every projection and push', async () => {
    const { id, code } = await open();
    const joined = await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    const listed = await call('darkchat:list', {});
    const members = await call('darkchat:members', { channel_id: id });
    const sent = await call('darkchat_messages:send', { channel_id: id, body: 'hi' });
    const page = await call('darkchat_messages:list', { channel_id: id }, 'CIT_B');
    await settle();
    const pushed = pushes.find((p) => p.event === 'message')!.payload.message;

    const ghost = liveOf(id, 'CIT_A')!.handle;
    const crow = liveOf(id, 'CIT_B')!.handle;
    expect(joined.channel.my_member_id).toBe(crow);
    expect(listed[0].my_member_id).toBe(ghost);
    expect(members.map((m: any) => m.id)).toEqual([crow, ghost]);
    expect(sent.member_id).toBe(ghost);
    expect(page.rows[0].member_id).toBe(ghost);
    expect(pushed.member_id).toBe(ghost);
    for (const handle of [ghost, crow]) expect(handle).toMatch(HANDLE);
  });

  it('lists members by alias with no numeric id anywhere', async () => {
    const { id, code } = await open('Docks', 'zed');
    await call('darkchat:join', { code, alias: 'amber' }, 'CIT_B');
    await call('darkchat:join', { code, alias: 'moss' }, 'CIT_C');
    const members = await call('darkchat:members', { channel_id: id }, 'CIT_C');
    expect(members.map((m: any) => m.alias)).toEqual(['amber', 'moss', 'zed']);
    const rowIds = w.members.map((m) => String(m.id));
    for (const member of members) {
      expect(Object.keys(member).toSorted()).toEqual(['alias', 'id']);
      expect(typeof member.id).toBe('string');
      expect(member.id).toMatch(HANDLE);
      expect(rowIds).not.toContain(member.id);
    }
    // The alias is sealed (MICA-432), so the order is the server's: the table hands the rows
    // back in join order — zed, amber, moss — and the reply above is sorted all the same.
    const sql = one(dbMock.query.mock.calls.at(-1)![0]);
    expect(sql).not.toContain('ORDER BY');
    expect(sql).not.toMatch(/SELECT `id`/);
  });

  it('removes by handle, and refuses a handle from another channel or a row id', async () => {
    const x = await open('X', 'ghost');
    await call('darkchat:join', { code: x.code, alias: 'crow' }, 'CIT_B');
    const y = await open('Y', 'ghost');
    await call('darkchat:join', { code: y.code, alias: 'owl' }, 'CIT_C');
    const owl = liveOf(y.id, 'CIT_C')!;

    expect(await call('darkchat:removeMember', { channel_id: x.id, member_id: owl.handle })).toBe(
      false
    );
    expect(liveOf(y.id, 'CIT_C')).toBeDefined();

    const byRowId = await call('darkchat:removeMember', {
      channel_id: x.id,
      member_id: liveOf(x.id, 'CIT_B')!.id
    });
    expect(byRowId.error).toBeDefined();
    expect(liveOf(x.id, 'CIT_B')).toBeDefined();

    expect(
      await call('darkchat:removeMember', {
        channel_id: x.id,
        member_id: liveOf(x.id, 'CIT_B')!.handle
      })
    ).toBe(true);
  });

  it('draws another handle when one is taken', async () => {
    const { id, code } = await open();
    const realInsert = dbMock.insert.getMockImplementation()!;
    let clashed = false;
    dbMock.insert.mockImplementation(async (sql: string, params: unknown[]) => {
      if (!clashed && one(sql).startsWith('INSERT INTO `mica_darkchat_members`')) {
        clashed = true;
        throw duplicate('mica_darkchat_members.handle');
      }
      return realInsert(sql, params);
    });
    const joined = await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    expect(joined.channel.my_member_id).toBe(liveOf(id, 'CIT_B')!.handle);
  });
});

describe('removal holds the owner predicate in the write (review)', () => {
  it('refuses a removal once ownership has moved, even past the check', async () => {
    const { id, code } = await open();
    await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    await call('darkchat:join', { code, alias: 'owl' }, 'CIT_C');
    // The handoff lands between the owner check and the write.
    channelById(id)!.citizenid = 'CIT_B';
    const realSingle = dbMock.single.getMockImplementation()!;
    dbMock.single.mockImplementation(async (sql: string, params: unknown[]) =>
      one(sql).startsWith('SELECT 1 FROM `mica_darkchat` WHERE `id` = ? AND `citizenid` = ?')
        ? { 1: 1 }
        : realSingle(sql, params)
    );
    const owl = liveOf(id, 'CIT_C')!;
    expect(await call('darkchat:removeMember', { channel_id: id, member_id: owl.handle })).toBe(
      false
    );
    expect(liveOf(id, 'CIT_C')).toBeDefined();
    const write = dbMock.update.mock.calls
      .map((c) => one(c[0]))
      .find((sql) => sql.startsWith('UPDATE `mica_darkchat_members` m JOIN'))!;
    expect(write).toContain(
      "JOIN `mica_darkchat` c ON c.`id` = m.`channel_id` AND c.`citizenid` = ? AND c.`status` = 'active'"
    );
  });
});

describe('a join racing the last leave (review)', () => {
  it('takes the seat back and answers the generic failure', async () => {
    const { id, code } = await open();
    const realInsert = dbMock.insert.getMockImplementation()!;
    dbMock.insert.mockImplementation(async (sql: string, params: unknown[]) => {
      const out = await realInsert(sql, params);
      // The last member leaves while the join's insert is in flight.
      if (one(sql).startsWith('INSERT INTO `mica_darkchat_members`') && params[1] === 'CIT_B') {
        channelById(id)!.status = 'deleted';
      }
      return out;
    });
    const reply = await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B');
    expect(reply).toEqual({ error: 'That code did not work.', key: 'server.darkchat.badCode' });
    expect(w.members.find((m) => m.citizenid === 'CIT_B')).toMatchObject({ status: 'left' });
    expect(liveOf(id, 'CIT_B')).toBeUndefined();
  });
});

describe('the join limiter under a burst (review)', () => {
  it('charges before the first read, so a parallel burst cannot all pass', async () => {
    await open();
    const handler = handlers.get('mica:server:darkchat:join')!;
    bridge.current = 'CIT_B';
    (globalThis as any).source = 5;
    const emit = vi.fn();
    (globalThis as any).emitNet = emit;
    await Promise.all(
      Array.from({ length: JOIN_FAILURES + 2 }, (_, i) =>
        handler(`cb-${i}`, { code: 'ZZZZZZZZ', alias: 'x' })
      )
    );
    const keys = emit.mock.calls.map((c) => c[3].key);
    expect(keys.filter((k) => k === 'server.darkchat.badCode')).toHaveLength(JOIN_FAILURES);
    expect(keys.filter((k) => k === 'server.darkchat.tooManyCodes')).toHaveLength(2);
  });

  it('refunds a join that succeeds', async () => {
    const { code } = await open();
    const bad = () => call('darkchat:join', { code: 'ZZZZZZZZ', alias: 'x' }, 'CIT_B');
    for (let i = 0; i < JOIN_FAILURES - 1; i += 1) await bad();
    expect((await call('darkchat:join', { code, alias: 'crow' }, 'CIT_B')).channel).toBeDefined();
    // The success cost nothing: this is the tenth failure, not the eleventh.
    expect((await bad()).key).toBe('server.darkchat.badCode');
    expect((await bad()).key).toBe('server.darkchat.tooManyCodes');
  });
});
