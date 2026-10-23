// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Glimpse (MICA-253): posts, comments, and the ❤️ that rides `accounts:react`.
 *
 * `Database` is mocked by a small in-memory world rather than queued answers, so a handler that
 * reads in a different order still meets the same rows, and a read **projects** what its SQL
 * names: a `citizenid` reaches a reply only if a statement selected it. That is what lets the
 * citizenid-free-projection tests below mean something without a real MariaDB — and also why
 * every statement here is proved separately on one (`pnpm test:migrations`, a throwaway
 * MariaDB), since this world answers SQL by its shape, not by executing it.
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
    pushes: [] as { kind: 'one' | 'many'; to: string | string[]; event: string; payload: any }[]
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

/**
 * The push channel, recorded. `throwOnPush` makes it throw synchronously, which is the worst
 * thing a push can do to the write that occasioned it.
 */
const pushControl = vi.hoisted(() => ({ throwOnPush: false }));
/** Make the attachment insert fail, as a photo purged after the ownership check would. */
const insertControl = vi.hoisted(() => ({ failAttachments: false }));
vi.mock('../lib/appEvents', () => ({
  appEventChannel: (appId: string) => ({
    appId,
    push: (to: string, event: string, payload: any) => {
      if (pushControl.throwOnPush) throw new Error('push exploded');
      pushes.push({ kind: 'one', to, event, payload });
      return { delivered: true };
    },
    pushMany: (to: string[], event: string, payload: any) => {
      if (pushControl.throwOnPush) throw new Error('push exploded');
      pushes.push({ kind: 'many', to, event, payload });
      return { delivered: to, offline: [] };
    }
  })
}));

import { glimpse } from '../services/Glimpse';
import { glimpseComments } from '../services/GlimpseComments';
import '../services/Reports';
import { installTestPhone, NOT_HELD_REPLY, refusePhone } from './phoneStub';
import { __resetRateLimits } from '../lib/rateLimit';
import { isReactableTable } from '../lib/reactions';
import { isReportableTable } from '../lib/moderation';

type AnyRow = Record<string, any>;

interface World {
  accounts: AnyRow[];
  blocks: [number, number][];
  follows: [number, number][];
  posts: AnyRow[];
  media: AnyRow[];
  attachments: AnyRow[];
  comments: AnyRow[];
  reactions: AnyRow[];
  nextId: number;
}

let w: World;

const ACCOUNTS = (): AnyRow[] =>
  [
    { id: 1, citizenid: 'CIT_A', app: 'glimpse', handle: 'ada', status: 'active' },
    { id: 2, citizenid: 'CIT_B', app: 'glimpse', handle: 'lena', status: 'active' },
    { id: 3, citizenid: 'CIT_C', app: 'glimpse', handle: 'owl', status: 'active' },
    // The same player's Blabber identity: same citizenid, another app's namespace.
    { id: 9, citizenid: 'CIT_A', app: 'blabber', handle: 'ada', status: 'active' }
  ].map((a) => ({ display_name: null, avatar: null, bio: null, ...a }));

const one = (s: string) => s.replace(/\s+/g, ' ').trim();

/** What a statement would hand back: only the columns its SELECT names. */
const project = (row: AnyRow | undefined, sql: string): AnyRow | null => {
  if (!row) return null;
  const list = /^SELECT (.*?) FROM /.exec(one(sql))?.[1] ?? '*';
  if (list.trim() === '*') return { ...row };
  const out: AnyRow = {};
  for (const part of list.split(',')) {
    const name = part
      .trim()
      .replace(/^\w+\./, '')
      .replace(/`/g, '');
    if (name in row) out[name] = row[name];
  }
  return out;
};

const blocked = (blocker: number, target: number) =>
  w.blocks.some(([a, b]) => a === blocker && b === target);

const post = (id: number) => w.posts.find((p) => p.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  installTestPhone();
  pushes.length = 0;
  pushControl.throwOnPush = false;
  insertControl.failAttachments = false;
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
  (globalThis as any).IsPlayerAceAllowed = () => false;
  w = {
    accounts: ACCOUNTS(),
    blocks: [],
    follows: [],
    posts: [
      { id: 10, citizenid: 'CIT_B', account_id: 2, caption: 'pier', status: 'active' },
      { id: 11, citizenid: 'CIT_C', account_id: 3, caption: 'owl at night', status: 'active' },
      { id: 12, citizenid: 'CIT_B', account_id: 2, caption: 'taken down', status: 'moderated' }
    ],
    media: [
      { id: 5, citizenid: 'CIT_A', kind: 'photo', status: 'active', url: 'https://cdn/5.jpg' },
      { id: 6, citizenid: 'CIT_A', kind: 'video', status: 'active' },
      { id: 7, citizenid: 'CIT_B', kind: 'photo', status: 'active' },
      { id: 8, citizenid: 'CIT_A', kind: 'photo', status: 'deleted' },
      { id: 70, citizenid: 'CIT_B', kind: 'photo', status: 'active', data: 'data:image/png;x' },
      { id: 71, citizenid: 'CIT_B', kind: 'photo', status: 'moderated', data: 'data:bad' }
    ],
    attachments: [
      { id: 1, post_id: 10, citizenid: 'CIT_B', media_id: 70 },
      { id: 2, post_id: 10, citizenid: 'CIT_B', media_id: 71 }
    ],
    comments: [
      // By Ada (1) under Lena's (2) post.
      { id: 40, citizenid: 'CIT_A', account_id: 1, post_id: 10, body: 'nice', status: 'active' },
      // By Owl (3) under Lena's (2) post.
      { id: 41, citizenid: 'CIT_C', account_id: 3, post_id: 10, body: 'hoot', status: 'active' }
    ],
    reactions: [],
    nextId: 100
  };

  dbMock.single.mockImplementation(async (raw: string, params: unknown[] = []) => {
    const sql = one(raw);
    if (sql.includes('FROM `mica_accounts` WHERE `id` = ? AND `citizenid` = ? AND `app` = ?')) {
      const [id, citizenid, app] = params;
      return (
        w.accounts.find(
          (a) => a.id === id && a.citizenid === citizenid && a.app === app && a.status === 'active'
        ) ?? null
      );
    }
    if (sql.includes('FROM `mica_accounts` WHERE `id` = ? AND `app` = ?')) {
      const [id, app] = params;
      return project(
        w.accounts.find((a) => a.id === id && a.app === app && a.status === 'active'),
        raw
      );
    }
    if (
      sql.includes(
        "FROM `mica_account_blocks` WHERE `status` = 'active' AND ((`blocker_account_id` IN"
      )
    ) {
      // `view`: [...mine, author, ...mine, author].
      const half = params.length / 2;
      const mine = params.slice(0, half - 1) as number[];
      const author = params[half - 1] as number;
      return mine.some((me) => blocked(me, author) || blocked(author, me)) ? { 1: 1 } : null;
    }
    if (sql.includes('FROM `mica_account_blocks`')) {
      return blocked(params[0] as number, params[1] as number) ? { id: 1 } : null;
    }
    if (sql.startsWith('SELECT * FROM `mica_media` WHERE `id` = ? AND `citizenid` = ?')) {
      return w.media.find((m) => m.id === params[0] && m.citizenid === params[1]) ?? null;
    }
    if (sql.includes('FROM `mica_glimpse` WHERE `id` = ?')) {
      const row = post(params[0] as number);
      if (!row || (sql.includes("`status` = 'active'") && row.status !== 'active')) return null;
      return project(row, raw);
    }
    if (sql.includes('FROM `mica_glimpse_comments` c JOIN `mica_glimpse` p')) {
      const comment = w.comments.find((c) => c.id === params[0]);
      return comment?.status === 'active' && post(comment.post_id)?.status === 'active'
        ? { 1: 1 }
        : null;
    }
    if (sql.includes('AS preview')) {
      const table = /FROM `(\w+)`/.exec(sql)?.[1];
      const rows =
        table === 'mica_glimpse' ? w.posts : table === 'mica_glimpse_comments' ? w.comments : [];
      const row = rows.find((r) => r.id === params[0]);
      return row
        ? { citizenid: row.citizenid, status: row.status, preview: row.caption ?? row.body }
        : null;
    }
    return null;
  });

  dbMock.query.mockImplementation(async (raw: string, params: unknown[] = []) => {
    const sql = one(raw);
    if (
      sql.includes(
        "FROM `mica_accounts` WHERE `citizenid` = ? AND `app` = ? AND `status` = 'active'"
      )
    ) {
      const [citizenid, app] = params;
      return w.accounts.filter(
        (a) => a.citizenid === citizenid && a.app === app && a.status === 'active'
      );
    }
    if (sql.includes('FROM `mica_accounts` WHERE `id` IN')) {
      return w.accounts.filter((a) => params.includes(a.id)).map((a) => project(a, raw));
    }
    if (
      sql.includes("FROM `mica_accounts` WHERE `app` = ? AND `status` = 'active' AND `handle` IN")
    ) {
      const [app, ...handles] = params;
      return w.accounts.filter((a) => a.app === app && handles.includes(a.handle));
    }
    if (sql.includes('FROM `mica_glimpse_attachments` a')) {
      return w.attachments
        .filter((a) => params.includes(a.post_id))
        .map((a) => ({ a, m: w.media.find((m) => m.id === a.media_id)! }))
        .filter(({ m }) => m.status !== 'moderated')
        .map(({ a, m }) => ({
          id: a.id,
          post_id: a.post_id,
          media_id: m.id,
          kind: m.kind,
          data: m.data ?? null,
          url: m.url ?? null,
          thumbnail: null,
          mime_type: null,
          duration_ms: null,
          alt_text: null
        }));
    }
    if (
      sql.includes('FROM `mica_glimpse_comments` c JOIN `mica_glimpse` p') &&
      sql.includes('COUNT')
    ) {
      const counts = new Map<number, number>();
      for (const c of w.comments) {
        if (c.status !== 'active' || post(c.post_id)?.status !== 'active') continue;
        if (!params.includes(c.post_id)) continue;
        counts.set(c.post_id, (counts.get(c.post_id) ?? 0) + 1);
      }
      return [...counts].map(([post_id, total]) => ({ post_id, total }));
    }
    if (sql.includes('FROM `mica_glimpse_comments` c JOIN `mica_glimpse` p')) {
      const [postId] = params;
      // [post, ...viewers, ...viewers, cursor?, limit] when the block clause is present.
      const tail = sql.includes('c.`id` < ?') ? 2 : 1;
      const viewers = sql.includes('`blocker_account_id` IN')
        ? (params.slice(1, 1 + (params.length - 1 - tail) / 2) as number[])
        : [];
      return w.comments
        .filter(
          (c) =>
            c.post_id === postId &&
            c.status === 'active' &&
            post(c.post_id)?.status === 'active' &&
            !viewers.some((me) => blocked(me, c.account_id) || blocked(c.account_id, me))
        )
        .sort((a, b) => b.id - a.id)
        .map((c) => project(c, raw));
    }
    if (sql.includes('FROM `mica_glimpse_comments` WHERE `id` = ?')) {
      return w.comments.filter((c) => c.id === params[0]).map((c) => project(c, raw));
    }
    if (sql.includes('FROM `mica_glimpse`')) {
      // The feed: live posts, less the viewer's blocks when the statement filters them.
      let rows = w.posts.filter((p) => p.status === 'active');
      if (sql.includes('`id` = ?')) rows = rows.filter((p) => p.id === params[0]);
      if (sql.includes('`blocker_account_id` = ?') && !sql.includes('followee')) {
        rows = rows.filter((p) => !blocked(params[0] as number, p.account_id));
      }
      return rows.sort((a, b) => b.id - a.id).map((p) => project(p, raw));
    }
    if (sql.includes('FROM `mica_account_reactions`')) return [];
    return [];
  });

  dbMock.insert.mockImplementation(async (raw: string, params: unknown[] = []) => {
    const m = /INSERT INTO `(\w+)` \(([^)]*)\) VALUES/.exec(one(raw));
    if (!m) return 1;
    const columns = m[2].split(',').map((c) => c.trim().replace(/`/g, ''));
    const table = m[1];
    if (table === 'mica_glimpse_attachments' && insertControl.failAttachments) {
      throw new Error('Cannot add or update a child row: a foreign key constraint fails');
    }
    let first = 0;
    for (let at = 0; at < params.length; at += columns.length) {
      const row: AnyRow = { id: w.nextId++, status: 'active' };
      columns.forEach((c, i) => (row[c] = params[at + i]));
      first ||= row.id;
      if (table === 'mica_glimpse') w.posts.push(row);
      if (table === 'mica_glimpse_attachments') w.attachments.push(row);
      if (table === 'mica_glimpse_comments') w.comments.push(row);
      if (table === 'mica_account_reactions') w.reactions.push(row);
    }
    return first;
  });

  dbMock.update.mockImplementation(async (raw: string, params: unknown[] = []) => {
    const sql = one(raw);
    if (sql.startsWith('UPDATE `mica_glimpse_comments` c JOIN `mica_glimpse` p')) {
      const [id, postOwner] = params;
      const comment = w.comments.find((c) => c.id === id);
      if (comment?.status !== 'active' || post(comment.post_id)?.account_id !== postOwner) {
        return false;
      }
      comment.status = 'deleted';
      return true;
    }
    if (sql.startsWith("UPDATE `mica_glimpse_comments` SET `status` = 'deleted'")) {
      const [id, author] = params;
      const comment = w.comments.find((c) => c.id === id);
      if (comment?.status !== 'active' || comment.account_id !== author) return false;
      comment.status = 'deleted';
      return true;
    }
    if (
      sql.startsWith('UPDATE `mica_glimpse` SET `status` = ? WHERE `id` = ? AND `citizenid` = ?')
    ) {
      const [status, id, citizenid] = params;
      const row = post(id as number);
      if (!row || row.citizenid !== citizenid) return false;
      row.status = status;
      return true;
    }
    return true;
  });
});

const call = async (event: string, data: unknown, citizenid = 'CIT_A') => {
  const handler = handlers.get(`mica:server:${event}`);
  if (!handler) throw new Error(`no handler for ${event}`);
  bridge.current = citizenid;
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls[0]?.[3];
};

/** Every value in a reply, flattened, so "no citizenid anywhere" is one assertion. */
const keysIn = (value: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) value.forEach((v) => keysIn(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysIn(v, out);
    }
  }
  return out;
};
const citizenIdsIn = (value: unknown) => JSON.stringify(value).match(/CIT_[A-Z]/g) ?? [];

const GONE = 'That content no longer exists.';
const NOT_YOURS = 'That account is not yours.';

describe('the declarations', () => {
  it('reads posts publicly, paged, writes by owner, and caps a caption edit at the convar', () => {
    expect(glimpse.resolved.access).toMatchObject({ read: 'public', write: 'owner' });
    expect(glimpse.resolved.paging).toEqual({ pageSize: 30, maxPageSize: 60 });
    expect(glimpse.resolved.editWindow).toBe(900);
    expect(glimpse.resolved.publicColumns).not.toContain('citizenid');
    // Only the caption is a client's to change; the posting account never is.
    expect(glimpse.resolved.clientWritable).toEqual(['caption']);
  });

  it('lets a comment be written by nothing generic, and never by a client field', () => {
    expect(glimpseComments.resolved.publicColumns).not.toContain('citizenid');
    expect(glimpseComments.resolved.clientWritable).toEqual([]);
    // No generic read, edit or delete is registered: each is reachable once it is (§2.9).
    // `create` is the custom one, below.
    for (const action of ['get', 'update', 'delete']) {
      expect(handlers.has(`mica:server:glimpse_comments:${action}`), action).toBe(false);
    }
    expect(handlers.has('mica:server:glimpse:get')).toBe(false);
    // The positive twin: the generic caption edit and delete on posts are registered.
    expect(handlers.has('mica:server:glimpse:update')).toBe(true);
    expect(handlers.has('mica:server:glimpse:delete')).toBe(true);
  });

  it('opts both tables into reports and posts into reactions', () => {
    expect(isReportableTable('mica_glimpse')).toBe(true);
    expect(isReportableTable('mica_glimpse_comments')).toBe(true);
    expect(isReactableTable('mica_glimpse')).toBe(true);
    expect(isReactableTable('mica_glimpse_comments')).toBe(false);
  });
});

describe('glimpse:create', () => {
  it('posts the caller’s own photo as the caller’s own account, and echoes no citizenid', async () => {
    const reply = await call('glimpse:create', {
      account_id: 1,
      caption: '  golden hour  ',
      attachments: [{ photo_id: 5 }]
    });

    expect(reply).toMatchObject({
      account_id: 1,
      caption: 'golden hour',
      handle: 'ada',
      editWindow: 900,
      attachments: [{ media: { id: 5, url: 'https://cdn/5.jpg' } }]
    });
    expect(citizenIdsIn(reply)).toEqual([]);
    expect(keysIn(reply).has('citizenid')).toBe(false);

    const created = w.posts.at(-1)!;
    expect(created).toMatchObject({ citizenid: 'CIT_A', account_id: 1, caption: 'golden hour' });
    expect(w.attachments.at(-1)).toMatchObject({
      post_id: created.id,
      citizenid: 'CIT_A',
      media_id: 5
    });
  });

  it('refuses an account that is not the caller’s, before reading any photo', async () => {
    const reply = await call('glimpse:create', { account_id: 2, attachments: [{ photo_id: 5 }] });
    expect(reply.error).toBe(NOT_YOURS);
    expect(w.posts).toHaveLength(3);
    expect(dbMock.single.mock.calls.some(([sql]) => String(sql).includes('mica_media'))).toBe(
      false
    );
  });

  it('refuses the caller’s own Blabber account: an account is per app', async () => {
    const reply = await call('glimpse:create', { account_id: 9, attachments: [{ photo_id: 5 }] });
    expect(reply.error).toBe(NOT_YOURS);
  });

  it.each([
    ['somebody else’s photo', 7],
    ['a video', 6],
    ['a photo the caller deleted', 8],
    ['a photo that does not exist', 999]
  ])('refuses a post whose only attachment is %s', async (_what, photoId) => {
    const reply = await call('glimpse:create', {
      account_id: 1,
      attachments: [{ photo_id: photoId }]
    });
    expect(reply).toMatchObject({ key: 'server.glimpse.needsPhoto' });
    expect(w.posts).toHaveLength(3);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('keeps the owned photo and drops the rest, rather than refusing a mixed list', async () => {
    await call('glimpse:create', {
      account_id: 1,
      attachments: [{ photo_id: 7 }, { photo_id: 5 }, { photo_id: 5 }]
    });
    const created = w.posts.at(-1)!;
    expect(w.attachments.filter((a) => a.post_id === created.id).map((a) => a.media_id)).toEqual([
      5
    ]);
  });

  it('inserts every photo in one statement, in posting order', async () => {
    w.media.push({ id: 15, citizenid: 'CIT_A', kind: 'photo', status: 'active' });
    await call('glimpse:create', {
      account_id: 1,
      attachments: [{ photo_id: 15 }, { photo_id: 5 }]
    });
    const inserts = dbMock.insert.mock.calls.filter(([sql]) =>
      String(sql).includes('mica_glimpse_attachments')
    );
    expect(inserts).toHaveLength(1);
    const created = w.posts.at(-1)!;
    expect(inserts[0][1]).toEqual([created.id, 'CIT_A', 15, created.id, 'CIT_A', 5]);
  });

  it('withdraws the post when its photos cannot be written, so nothing live is photoless', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    insertControl.failAttachments = true;
    try {
      const reply = await call('glimpse:create', {
        account_id: 1,
        attachments: [{ photo_id: 5 }]
      });
      expect(reply.error).toBeDefined();
      const created = w.posts.at(-1)!;
      expect(created).toMatchObject({ citizenid: 'CIT_A', account_id: 1, status: 'deleted' });
      // Withdrawn under its own owner, not by id alone.
      expect(
        dbMock.update.mock.calls.some(
          ([sql, params]) =>
            one(String(sql)).startsWith('UPDATE `mica_glimpse` SET `status` = ?') &&
            (params as unknown[]).includes('CIT_A')
        )
      ).toBe(true);
      // And the feed shows no trace of it.
      const feed = await call('glimpse:feed', {});
      expect(feed.rows.map((r: AnyRow) => r.id)).not.toContain(created.id);
    } finally {
      errors.mockRestore();
    }

    // The positive twin: the retry posts once, with its photo.
    insertControl.failAttachments = false;
    await call('glimpse:create', { account_id: 1, attachments: [{ photo_id: 5 }] });
    const live = w.posts.filter((p) => p.citizenid === 'CIT_A' && p.status === 'active');
    expect(live).toHaveLength(1);
    expect(w.attachments.filter((a) => a.post_id === live[0].id)).toHaveLength(1);
  });

  it('refuses an empty attachment list by contract, before anything is read', async () => {
    const reply = await call('glimpse:create', { account_id: 1, attachments: [] });
    expect(reply.error).toBeDefined();
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('refuses a player holding no phone, before anything is read or written', async () => {
    refusePhone();
    try {
      const reply = await call('glimpse:create', {
        account_id: 1,
        attachments: [{ photo_id: 5 }]
      });
      expect(reply).toEqual(NOT_HELD_REPLY);
      expect(dbMock.single).not.toHaveBeenCalled();
      expect(dbMock.insert).not.toHaveBeenCalled();
    } finally {
      installTestPhone();
    }
  });

  it('tells a mentioned account, not the author, and never fails the post on a push', async () => {
    await call('glimpse:create', {
      account_id: 1,
      caption: 'with @lena and @ada',
      attachments: [{ photo_id: 5 }]
    });
    await vi.waitFor(() => expect(pushes).toHaveLength(1));
    expect(pushes[0]).toMatchObject({ event: 'mention', to: ['CIT_B'] });
    expect(pushes[0].payload).toMatchObject({ handle: 'ada' });

    pushControl.throwOnPush = true;
    const reply = await call('glimpse:create', {
      account_id: 1,
      caption: 'again @lena',
      attachments: [{ photo_id: 5 }]
    });
    expect(reply.error).toBeUndefined();
    expect(reply.id).toBeGreaterThan(0);
  });

  it('skips a mention of an account that blocked the author', async () => {
    w.blocks.push([2, 1]);
    await call('glimpse:create', {
      account_id: 1,
      caption: 'hi @lena',
      attachments: [{ photo_id: 5 }]
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushes).toEqual([]);
  });
});

describe('the generic caption edit and delete', () => {
  it('edits only the caption, on the caller’s row, inside the edit window', async () => {
    await call('glimpse:update', { id: 10, caption: 'fixed' });
    const [sql, params] = dbMock.update.mock.calls[0] as [string, unknown[]];
    expect(one(sql)).toMatch(
      /^UPDATE `mica_glimpse` SET `caption` = \? WHERE `id` = \? AND `citizenid` = \?/
    );
    expect(one(sql)).toContain('`created_at` > NOW() - INTERVAL ? SECOND');
    expect(params).toEqual(expect.arrayContaining(['fixed', 10, 'CIT_A', 900]));
  });

  it('refuses moving a post to another account', async () => {
    const reply = await call('glimpse:update', { id: 10, account_id: 3 });
    expect(dbMock.update.mock.calls.some(([sql]) => String(sql).includes('`account_id` ='))).toBe(
      false
    );
    expect(reply === false || reply?.error !== undefined).toBe(true);
  });

  it('soft-deletes, scoped to the caller', async () => {
    await call('glimpse:delete', { id: 10 });
    const [sql, params] = dbMock.update.mock.calls[0] as [string, unknown[]];
    expect(one(sql)).toMatch(
      /^UPDATE `mica_glimpse` SET `status` = \? WHERE `id` = \? AND `citizenid` = \?/
    );
    expect(params).toEqual(expect.arrayContaining(['deleted', 10, 'CIT_A']));
  });
});

describe('the reads', () => {
  it('drops the posts of an account the viewer blocked from the feed, and only for them', async () => {
    w.blocks.push([1, 3]);
    const mine = await call('glimpse:feed', { account_id: 1 });
    expect(mine.rows.map((r: AnyRow) => r.id)).toEqual([10]);

    // The positive twin: an anonymous read, and another viewer, still see Owl's post.
    const anonymous = await call('glimpse:feed', {});
    expect(anonymous.rows.map((r: AnyRow) => r.id)).toEqual([11, 10]);
    const lena = await call('glimpse:feed', { account_id: 2 }, 'CIT_B');
    expect(lena.rows.map((r: AnyRow) => r.id)).toEqual([11, 10]);
  });

  it('does not filter by an account the caller does not own', async () => {
    w.blocks.push([2, 3]);
    // Lena's blocks are Lena's: naming her account from Ada's session filters nothing.
    const reply = await call('glimpse:feed', { account_id: 2 });
    expect(reply.rows.map((r: AnyRow) => r.id)).toEqual([11, 10]);
  });

  it('hydrates authors and live photos, drops moderated media, and carries no citizenid', async () => {
    const reply = await call('glimpse:feed', {});
    const pier = reply.rows.find((r: AnyRow) => r.id === 10);
    expect(pier).toMatchObject({ handle: 'lena', caption: 'pier' });
    expect(pier.attachments.map((a: AnyRow) => a.media.id)).toEqual([70]);
    expect(citizenIdsIn(reply)).toEqual([]);
    expect(keysIn(reply).has('citizenid')).toBe(false);

    const sql = one(
      String(
        dbMock.query.mock.calls.find(([s]) => String(s).includes('mica_glimpse_attachments'))![0]
      )
    );
    expect(sql).toContain('m.url');
    expect(sql).toContain("m.status NOT IN ('moderated', 'expired', 'erased')");
  });

  it('answers view with null for a moderated post and the post for a live one', async () => {
    expect(await call('glimpse:view', { id: 12 })).toBeNull();
    const live = await call('glimpse:view', { id: 11 });
    expect(live).toMatchObject({ id: 11, handle: 'owl' });
    expect(citizenIdsIn(live)).toEqual([]);
  });

  it.each([
    ['the viewer blocked the author', [1, 3] as [number, number]],
    ['the author blocked the viewer', [3, 1] as [number, number]]
  ])('answers view with null when %s', async (_what, block) => {
    w.blocks.push(block);
    expect(await call('glimpse:view', { id: 11 })).toBeNull();
    // The positive twin: a player with no block between them sees it.
    expect(await call('glimpse:view', { id: 11 }, 'CIT_B')).toMatchObject({ id: 11 });
  });

  it('answers a profile with its public account and no citizenid, empty for a blocker', async () => {
    const open = await call('glimpse:profile', { account_id: 2 });
    expect(open.account).toMatchObject({ id: 2, handle: 'lena' });
    expect(citizenIdsIn(open)).toEqual([]);
    expect(keysIn(open).has('citizenid')).toBe(false);

    w.blocks.push([1, 2]);
    const blockedView = await call('glimpse:profile', { account_id: 2, viewer_account_id: 1 });
    expect(blockedView).toMatchObject({ account: { id: 2 }, rows: [], nextCursor: null });

    // An account in another app's namespace is not a Glimpse profile.
    expect(await call('glimpse:profile', { account_id: 9 })).toEqual({
      account: null,
      rows: [],
      nextCursor: null
    });
  });

  it('refuses following for an account the caller does not own', async () => {
    const reply = await call('glimpse:following', { account_id: 2 });
    expect(reply.error).toBe(NOT_YOURS);
  });

  it('counts live comments under live posts, and answers every id asked', async () => {
    w.comments.push({ id: 42, account_id: 1, post_id: 10, body: 'gone', status: 'deleted' });
    w.comments.push({ id: 43, account_id: 1, post_id: 12, body: 'hidden', status: 'active' });
    expect(await call('glimpse:engagement', { ids: [10, 11, 12] })).toEqual({
      10: { comments: 2 },
      11: { comments: 0 },
      12: { comments: 0 }
    });
  });
});

describe('glimpse_comments:create', () => {
  it('comments on a live post, tells the post’s owner, and echoes no citizenid', async () => {
    const reply = await call('glimpse_comments:create', {
      account_id: 1,
      post_id: 10,
      body: ' lovely '
    });
    expect(reply).toMatchObject({ post_id: 10, account_id: 1, body: 'lovely', handle: 'ada' });
    expect(citizenIdsIn(reply)).toEqual([]);
    expect(w.comments.at(-1)).toMatchObject({ citizenid: 'CIT_A', account_id: 1, post_id: 10 });
    expect(pushes).toContainEqual(
      expect.objectContaining({
        event: 'comment',
        to: 'CIT_B',
        payload: expect.objectContaining({ post_id: 10 })
      })
    );
  });

  it('does not tell a player about their own comment on their own post', async () => {
    await call('glimpse_comments:create', { account_id: 2, post_id: 10, body: 'thanks' }, 'CIT_B');
    expect(pushes.filter((p) => p.event === 'comment')).toEqual([]);
  });

  it('never fails the comment when the push throws', async () => {
    pushControl.throwOnPush = true;
    const reply = await call('glimpse_comments:create', { account_id: 1, post_id: 10, body: 'x' });
    expect(reply.error).toBeUndefined();
    expect(w.comments.at(-1)).toMatchObject({ body: 'x' });
  });

  it('mentions, but not the post owner twice nor the author', async () => {
    await call('glimpse_comments:create', {
      account_id: 1,
      post_id: 10,
      body: '@lena @owl @ada look'
    });
    await vi.waitFor(() => expect(pushes.filter((p) => p.event === 'mention')).toHaveLength(1));
    expect(pushes.find((p) => p.event === 'mention')).toMatchObject({ to: ['CIT_C'] });
  });

  it.each([
    ['the commenter blocked the post’s author', [1, 2] as [number, number]],
    ['the post’s author blocked the commenter', [2, 1] as [number, number]]
  ])('refuses when %s', async (_what, block) => {
    w.blocks.push(block);
    const reply = await call('glimpse_comments:create', { account_id: 1, post_id: 10, body: 'x' });
    expect(reply).toMatchObject({ key: 'server.glimpse.cannotComment' });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a moderated post, and an account that is not the caller’s', async () => {
    expect(
      (await call('glimpse_comments:create', { account_id: 1, post_id: 12, body: 'x' })).error
    ).toBe(GONE);
    expect(
      (await call('glimpse_comments:create', { account_id: 2, post_id: 10, body: 'x' })).error
    ).toBe(NOT_YOURS);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a player holding no phone', async () => {
    refusePhone();
    try {
      expect(
        await call('glimpse_comments:create', { account_id: 1, post_id: 10, body: 'x' })
      ).toEqual(NOT_HELD_REPLY);
    } finally {
      installTestPhone();
    }
  });
});

describe('glimpse_comments:list', () => {
  it('pages a live post’s live comments, authors joined, no citizenid', async () => {
    const reply = await call('glimpse_comments:list', { post_id: 10 });
    expect(reply.rows.map((r: AnyRow) => [r.id, r.handle])).toEqual([
      [41, 'owl'],
      [40, 'ada']
    ]);
    expect(citizenIdsIn(reply)).toEqual([]);
    expect(keysIn(reply).has('citizenid')).toBe(false);
  });

  it.each([
    ['the viewer blocked the commenter', [1, 3] as [number, number]],
    ['the commenter blocked the viewer', [3, 1] as [number, number]]
  ])('leaves out a comment when %s', async (_what, block) => {
    w.blocks.push(block);
    const reply = await call('glimpse_comments:list', { post_id: 10 });
    expect(reply.rows.map((r: AnyRow) => r.id)).toEqual([40]);
    // The positive twin: another player, who has no block, still sees Owl's comment.
    const lena = await call('glimpse_comments:list', { post_id: 10 }, 'CIT_B');
    expect(lena.rows.map((r: AnyRow) => r.id)).toEqual([41, 40]);
  });

  it('shows nothing under a moderated post', async () => {
    w.comments.push({
      id: 44,
      citizenid: 'CIT_A',
      account_id: 1,
      post_id: 12,
      body: 'x',
      status: 'active'
    });
    expect((await call('glimpse_comments:list', { post_id: 12 })).rows).toEqual([]);
  });
});

describe('glimpse_comments:remove', () => {
  it('lets the author remove their own comment', async () => {
    expect(await call('glimpse_comments:remove', { account_id: 1, id: 40 })).toBe(true);
    expect(w.comments.find((c) => c.id === 40)?.status).toBe('deleted');
  });

  it('lets the post’s owner remove a comment somebody else wrote', async () => {
    expect(await call('glimpse_comments:remove', { account_id: 2, id: 41 }, 'CIT_B')).toBe(true);
    expect(w.comments.find((c) => c.id === 41)?.status).toBe('deleted');
  });

  it('refuses a stranger: neither the author nor the post’s owner', async () => {
    // Ada wrote 40, not 41, and does not own post 10.
    const reply = await call('glimpse_comments:remove', { account_id: 1, id: 41 });
    expect(reply.error).toBe(GONE);
    expect(w.comments.find((c) => c.id === 41)?.status).toBe('active');
  });

  it('refuses naming the post owner’s account from another session', async () => {
    const reply = await call('glimpse_comments:remove', { account_id: 2, id: 41 });
    expect(reply.error).toBe(NOT_YOURS);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('does not turn a moderated comment into a deleted one', async () => {
    w.comments.find((c) => c.id === 41)!.status = 'moderated';
    const reply = await call('glimpse_comments:remove', { account_id: 2, id: 41 }, 'CIT_B');
    expect(reply.error).toBe(GONE);
    expect(w.comments.find((c) => c.id === 41)?.status).toBe('moderated');
  });

  it('decides and writes each attempt in one statement, author first', async () => {
    await call('glimpse_comments:remove', { account_id: 2, id: 41 }, 'CIT_B');
    const calls = dbMock.update.mock.calls.map(([sql, params]) => [one(String(sql)), params]);
    expect(calls).toEqual([
      [
        "UPDATE `mica_glimpse_comments` SET `status` = 'deleted' WHERE `id` = ? AND `status` = 'active' AND `account_id` = ?",
        [41, 2]
      ],
      [
        "UPDATE `mica_glimpse_comments` c JOIN `mica_glimpse` p ON p.`id` = c.`post_id` SET c.`status` = 'deleted' WHERE c.`id` = ? AND c.`status` = 'active' AND p.`account_id` = ?",
        [41, 2]
      ]
    ]);
  });

  /** The audit-ledger inserts, decoded into the columns `AuditLogger.log` writes. */
  const audits = () =>
    dbMock.insert.mock.calls
      .filter(([sql]) => String(sql).includes('mica_audit_logs'))
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
          details: JSON.parse(String(details))
        };
      });

  it('audits a removal, naming who removed it and by which right', async () => {
    await call('glimpse_comments:remove', { account_id: 1, id: 40 });
    await call('glimpse_comments:remove', { account_id: 2, id: 41 }, 'CIT_B');
    expect(audits()).toEqual([
      {
        citizenid: 'CIT_A',
        action: 'deleted',
        service: 'glimpse_comments',
        method: 'remove',
        targetId: 40,
        targetTable: 'mica_glimpse_comments',
        details: { role: 'author', account_id: 1 }
      },
      {
        citizenid: 'CIT_B',
        action: 'deleted',
        service: 'glimpse_comments',
        method: 'remove',
        targetId: 41,
        targetTable: 'mica_glimpse_comments',
        details: { role: 'post_owner', account_id: 2 }
      }
    ]);
  });

  it('writes the audit row before answering, and none for a refused removal', async () => {
    // The ledger write resolves late; an un-awaited log would answer the client first.
    let answeredBeforeAudit: boolean | null = null;
    dbMock.insert.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      answeredBeforeAudit = (globalThis.emitNet as any).mock.calls.length > 0;
      return 1;
    });
    expect(await call('glimpse_comments:remove', { account_id: 1, id: 40 })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(audits()).toHaveLength(1);
    expect(answeredBeforeAudit).toBe(false);

    dbMock.insert.mockClear();
    expect((await call('glimpse_comments:remove', { account_id: 1, id: 41 })).error).toBe(GONE);
    expect(audits()).toEqual([]);
  });
});

describe('likes, through accounts:react', () => {
  const react = (over: AnyRow = {}, citizenid = 'CIT_A') =>
    call(
      'accounts:react',
      {
        app: 'glimpse',
        account_id: 1,
        target_table: 'mica_glimpse',
        target_id: 10,
        emoji: '❤️',
        ...over
      },
      citizenid
    );

  it('stores a ❤️ on a live post', async () => {
    expect(await react()).toBe(true);
    expect(w.reactions).toEqual([
      expect.objectContaining({ account_id: 1, target_table: 'mica_glimpse', target_id: 10 })
    ]);
  });

  it.each(['😂', '❤', '👍'])('refuses %s, before anything is written', async (emoji) => {
    const reply = await react({ emoji });
    expect(reply).toMatchObject({ key: 'server.accounts.notReactable' });
    expect(w.reactions).toEqual([]);
  });

  it('refuses a moderated post, a Blabber account, and a block either way', async () => {
    expect((await react({ target_id: 12 })).error).toBe(GONE);
    expect((await react({ app: 'blabber', account_id: 9 })).error).toBe(GONE);
    w.blocks.push([2, 1]);
    expect((await react()).error).toBe(GONE);
    w.blocks = [[1, 2]];
    expect((await react()).error).toBe(GONE);
    expect(w.reactions).toEqual([]);
  });
});

describe('reports', () => {
  const report = (targetTable: string, targetId: number) =>
    call('reports:create', { targetTable, targetId, category: 'other' }, 'CIT_C');

  it('files against a live post and a live comment', async () => {
    expect(await report('mica_glimpse', 10)).toMatchObject({ ok: true });
    expect(await report('mica_glimpse_comments', 40)).toMatchObject({ ok: true });
  });

  it('refuses a moderated post, and a live comment under one', async () => {
    w.comments.push({
      id: 45,
      citizenid: 'CIT_A',
      account_id: 1,
      post_id: 12,
      body: 'x',
      status: 'active'
    });
    expect((await report('mica_glimpse', 12)).error).toBe(GONE);
    expect((await report('mica_glimpse_comments', 45)).error).toBe(GONE);
  });

  it('reaches a photo through a live post it is attached to', async () => {
    const reachable = vi.fn(async (raw: string) => {
      const sql = one(raw);
      expect(sql).toContain(
        "EXISTS (SELECT 1 FROM `mica_glimpse_attachments` a JOIN `mica_glimpse` g ON g.`id` = a.`post_id` WHERE a.`media_id` = x.`id` AND g.`status` = 'active')"
      );
      return { 1: 1 };
    });
    const previous = dbMock.single.getMockImplementation()!;
    dbMock.single.mockImplementation(async (raw: string, params: unknown[]) =>
      String(raw).includes('FROM `mica_media` x') ? reachable(raw) : previous(raw, params)
    );
    await report('mica_media', 70);
    expect(reachable).toHaveBeenCalled();
  });
});
