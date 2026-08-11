import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const bridge = vi.hoisted(() => ({ current: 'CIT_A' }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.current, source: 5, setMeta: () => {} }),
    getCitizenId: () => bridge.current,
    registerUsableItem: () => {}
  }
}));

import { blabber } from '../services/Blabber';
import type { BlabberRepository } from '../repositories/BlabberRepository';

const repo = blabber.repo as BlabberRepository;

/** A row as it comes off the Blab table, before anything has been joined onto it. */
const blab = (over: Record<string, unknown> = {}): any => ({
  id: 10,
  account_id: 1,
  body: 'something',
  reply_to: null,
  mouth_of: null,
  status: 'active',
  ...over
});

const author = (id: number, handle: string, over: Record<string, unknown> = {}) => ({
  id,
  handle,
  display_name: null,
  avatar: null,
  ...over
});

const call = async (action: string, data: unknown, citizenid = 'CIT_A') => {
  const handler = handlers.get(`gphone:server:blabber:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);
  bridge.current = citizenid;
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls[0]?.[3];
};

const MY_ACCOUNT = { id: 1, citizenid: 'CIT_A', app: 'blabber', handle: 'ada', status: 'active' };

beforeEach(() => {
  /**
   * `mockReset`, not just `clearAllMocks`.
   *
   * `clearAllMocks` drops recorded calls and leaves queued `mockResolvedValueOnce` values in
   * place. A test whose handler returns early never consumes the value it queued, so it shifts
   * the *next* test's queue by one and that test asserts against the wrong row — which shows up
   * as a security check appearing not to fire, rather than as anything that looks like a broken
   * mock.
   */
  vi.clearAllMocks();
  dbMock.single.mockReset();
  dbMock.insert.mockReset();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(50);
  dbMock.update.mockResolvedValue(true);
  dbMock.single.mockResolvedValue(null);
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
});

/**
 * Blabber, the first public table.
 *
 * The declaration assertions matter as much as the handler ones: this is the first thing in the
 * codebase whose rows are readable by players who do not own them, so what it *declares* is
 * what keeps a citizenid from crossing to a reader.
 */

describe('the declaration', () => {
  it('reads publicly and writes by owner', () => {
    expect(blabber.resolved.access).toEqual({ read: 'public', write: 'owner' });
  });

  it('withholds citizenid from every public read', () => {
    // On a feed this is the field that would correlate an alt back to whoever owns it.
    expect(blabber.resolved.publicColumns).not.toContain('citizenid');
    expect(blabber.resolved.publicColumns).toEqual(
      expect.arrayContaining(['id', 'account_id', 'body', 'reply_to'])
    );
  });

  it('declares paging, without which a public read returns the whole table', () => {
    expect(blabber.resolved.paging).toEqual({ pageSize: 30, maxPageSize: 60 });
  });

  it('time-boxes editing', () => {
    expect(blabber.resolved.editWindow).toBe(900);
  });

  it('lets one account mouth a Blab only once, by index', () => {
    // Safe as a unique index because MySQL permits many NULLs in one: every ordinary post has
    // `mouth_of NULL`, so this constrains mouths only. A find-then-insert would have a race two
    // rapid taps would find.
    const unique = blabber.resolved.indexes.find((i) => i.name === 'account_mouth');
    expect(unique).toMatchObject({ columns: ['account_id', 'mouth_of'], unique: true });
  });

  it('makes an ear unique per account, in the child table', () => {
    const ears = blabber.resolved.childTables.find((t) => t.name === 'gphone_blabber_ears');
    expect(ears).toBeDefined();
    const unique = (ears?.indexes ?? []).find((i: any) => i.name === 'blab_account');
    expect(unique).toMatchObject({ unique: true });
  });

  it('lets an author edit only the body', () => {
    // account_id and reply_to are set at create and never after: either being writable would
    // let somebody reattribute their words to an alt, or re-parent them into another thread.
    expect(blabber.resolved.clientWritable).toEqual(['body']);
  });

  it('caps a Blab at 280 characters, server-side', () => {
    expect(blabber.resolved.columnRules.body).toMatchObject({ maxLength: 280 });
  });

  it('indexes what a public read filters on, without a citizenid prefix', () => {
    // `index: true` pairs a column with citizenid, which a public read never filters by.
    const names = blabber.resolved.indexes.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(['account_id', 'reply_to']));
    expect(names).not.toContain('citizenid_account_id');
  });
});

describe('posting', () => {
  it('accepts a post from an account the caller owns', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    const reply = await call('create', { account_id: 1, body: 'hello' });

    expect(reply).toMatchObject({ id: 50, account_id: 1, handle: 'ada', body: 'hello' });
  });

  it('refuses an account the caller does not own', async () => {
    // The account id is chosen by the client and proves nothing (§2.9). Without this check a
    // player posts as anyone's handle by guessing an id.
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('create', { account_id: 999, body: 'impersonation' });

    expect(reply.error).toMatch(/not yours to post from/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses an empty body', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    const reply = await call('create', { account_id: 1, body: '   ' });

    expect(reply.error).toMatch(/needs something in it/);
  });

  it('refuses a reply to a post that has been moderated', async () => {
    // Otherwise a client attaches a reply to removed content and resurrects it in a thread view.
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce({ id: 9, status: 'moderated' });

    const reply = await call('create', { account_id: 1, body: 'reviving this', reply_to: 9 });

    expect(reply.error).toMatch(/no longer available/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

describe('root_id inheritance', () => {
  it('is null for a top-level post', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.insert.mockResolvedValueOnce(50);

    await call('create', { account_id: 1, body: 'top level' });

    const [, values] = dbMock.insert.mock.calls[0];
    const columns = String(dbMock.insert.mock.calls[0][0]);
    // root_id must be present in the INSERT and bound as null.
    expect(columns).toContain('root_id');
    expect(values).toContain(null);
  });

  it('is the parent id for a reply to a top-level post', async () => {
    dbMock.single
      .mockResolvedValueOnce(MY_ACCOUNT) // ownedAccount
      .mockResolvedValueOnce(blab({ id: 9, root_id: null })); // visibleTarget(reply_to)
    dbMock.insert.mockResolvedValueOnce(51);

    await call('create', { account_id: 1, body: 'a reply', reply_to: 9 });

    const values = dbMock.insert.mock.calls[0][1] as unknown[];
    expect(values).toContain(9);
  });

  it('inherits the grandparent for a reply to a reply', async () => {
    dbMock.single
      .mockResolvedValueOnce(MY_ACCOUNT)
      .mockResolvedValueOnce(blab({ id: 12, root_id: 9 })); // the parent is itself a reply
    dbMock.insert.mockResolvedValueOnce(52);

    await call('create', { account_id: 1, body: 'a reply to a reply', reply_to: 12 });

    const [columns, values] = dbMock.insert.mock.calls[0];
    // Skip the table name — it is backtick-quoted too, and precedes the column list.
    const columnNames = String(columns)
      .match(/`([a-z_]+)`/g)!
      .slice(1)
      .map((c) => c.replace(/`/g, ''));
    // reply_to still correctly names the immediate parent (12); root_id is the true top-level
    // ancestor (9), inherited rather than re-walked from reply_to.
    expect((values as unknown[])[columnNames.indexOf('root_id')]).toBe(9);
    expect((values as unknown[])[columnNames.indexOf('reply_to')]).toBe(12);
  });
});

describe('hashtag indexing', () => {
  it('writes one row per distinct tag on create', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.insert.mockResolvedValueOnce(50); // the Blab row itself
    dbMock.insert.mockResolvedValue(1); // every subsequent insert (the tag rows)

    await call('create', { account_id: 1, body: 'loving #LosAngeles and #losangeles today' });

    const tagInserts = dbMock.insert.mock.calls.filter(([sql]) =>
      String(sql).includes('gphone_blabber_tags')
    );
    expect(tagInserts).toHaveLength(1); // deduplicated by taggedTopics
    expect(tagInserts[0][1]).toEqual([50, 'losangeles']);
  });

  it('writes nothing when the body has no tags', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.insert.mockResolvedValueOnce(50);

    await call('create', { account_id: 1, body: 'no tags in this one' });

    const tagInserts = dbMock.insert.mock.calls.filter(([sql]) =>
      String(sql).includes('gphone_blabber_tags')
    );
    expect(tagInserts).toHaveLength(0);
  });

  it('caps the number of tags stored per Blab at 20', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.insert.mockResolvedValueOnce(50);
    dbMock.insert.mockResolvedValue(1);

    const body = Array.from({ length: 25 }, (_, i) => `#tag${i}`).join(' ');
    await call('create', { account_id: 1, body });

    const tagInserts = dbMock.insert.mock.calls.filter(([sql]) =>
      String(sql).includes('gphone_blabber_tags')
    );
    expect(tagInserts).toHaveLength(20);
  });
});

describe('a profile feed', () => {
  it('splits Blabs from replies with a null check, not an equality filter', async () => {
    await call('profile', { account_id: 1, tab: 'blabs' });
    expect(String(dbMock.query.mock.calls[0][0])).toContain('`reply_to` IS NULL');

    dbMock.query.mockClear();
    await call('profile', { account_id: 1, tab: 'replies' });
    expect(String(dbMock.query.mock.calls[0][0])).toContain('`reply_to` IS NOT NULL');
  });

  it('never selects citizenid, even on a profile', async () => {
    await call('profile', { account_id: 1, tab: 'blabs' });

    const sql = String(dbMock.query.mock.calls[0][0]);
    expect(sql).not.toContain('citizenid');
  });

  it('keeps every payload value bound and clamps the page size', async () => {
    await call('profile', { account_id: 1, tab: 'blabs', cursor: 40, limit: 5000 });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('`id` < ?');
    // account id, cursor, then limit+1 clamped to maxPageSize.
    expect(params).toEqual([1, 40, 61]);
  });

  it('refuses a non-numeric account id', async () => {
    const reply = await call('profile', { account_id: '; DROP TABLE', tab: 'blabs' });

    expect(reply.error).toBeTruthy();
    expect(dbMock.query).not.toHaveBeenCalled();
  });
});

describe('replies, mouths and likes', () => {
  it('accepts a reply to a reply, because a reply is just a Blab', async () => {
    // The reason `reply_to` self-references rather than getting its own table: nesting is the
    // same column one level deeper, so a thread needs no recursive query and no second shape.
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce({ id: 4, status: 'active', reply_to: 1 });

    const reply = await call('create', { account_id: 1, body: 'thank you', reply_to: 4 });

    expect(reply).toMatchObject({ id: 50, reply_to: 4 });
  });

  it('accepts a plain mouth with no body of its own', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce({ id: 9, status: 'active' });

    const reply = await call('create', { account_id: 1, mouth_of: 9 });

    expect(reply).toMatchObject({ mouth_of: 9, body: null });
  });

  it('accepts a mouth with a body as a quote', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce({ id: 9, status: 'active' });

    const reply = await call('create', { account_id: 1, mouth_of: 9, body: 'look at this' });

    expect(reply).toMatchObject({ mouth_of: 9, body: 'look at this' });
  });

  it('refuses a Blab that is neither a body nor a mouth', async () => {
    // It would render as an empty row nobody can explain.
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    const reply = await call('create', { account_id: 1, body: '  ' });

    expect(reply.error).toMatch(/needs something in it/);
  });

  it('refuses a Blab that tries to be both a reply and a mouth', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce({ id: 4, status: 'active' });
    dbMock.single.mockResolvedValueOnce({ id: 9, status: 'active' });

    const reply = await call('create', { account_id: 1, body: 'x', reply_to: 4, mouth_of: 9 });

    expect(reply.error).toMatch(/reply or mouth, not both/);
  });

  it('refuses mouthing a moderated Blab', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce({ id: 9, status: 'moderated' });

    const reply = await call('create', { account_id: 1, mouth_of: 9 });

    expect(reply.error).toMatch(/no longer available/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('translates a second mouth of the same Blab into something readable', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce({ id: 9, status: 'active' });
    dbMock.insert.mockRejectedValueOnce(new Error("Duplicate entry '1-9' for key 'account_mouth'"));

    const reply = await call('create', { account_id: 1, mouth_of: 9 });

    expect(reply.error).toBe('You have already mouthed that.');
  });

  it('treats a duplicate ear as success, so a double tap is not an error', async () => {
    // The unique index makes it idempotent; a read-then-write would have a race two taps find.
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce({ id: 9, status: 'active' });
    dbMock.insert.mockRejectedValueOnce(new Error('Duplicate entry for key blab_account'));

    await expect(call('ear', { account_id: 1, blab_id: 9 })).resolves.toBe(true);
  });

  it('scopes an unear to the caller own account', async () => {
    // A row id is not authorization to remove somebody else's ear (§2.9).
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    await call('unear', { account_id: 1, blab_id: 9 });

    const params = dbMock.update.mock.calls[0][1] as unknown[];
    expect(params).toEqual([9, 1]);
  });

  it('refuses to ear as an account the caller does not own', async () => {
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('ear', { account_id: 999, blab_id: 9 });

    expect(reply.error).toMatch(/not yours/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

/**
 * Author hydration.
 *
 * The bug this covers was invisible to every other suite: `Blab.handle`, `display_name` and
 * `avatar` are rendered by `BlabRow`, `Thread` and `Profile`, nothing joined `gphone_accounts`,
 * and the browser mock embeds a handle on every fixture — so `pnpm dev` and Playwright were
 * green while the feed in game rendered `@` and a blank name. A server test is the only place
 * this can be held, which is the point AGENTS.md §9 makes about server code being outside `tsc`.
 */
describe('author hydration', () => {
  it('attaches the handle, display name and avatar to every row', async () => {
    dbMock.query.mockResolvedValueOnce([
      author(1, 'ada', { display_name: 'Ada', avatar: 'a.png' })
    ]);

    const rows = await repo.hydrate([blab({ id: 10 }), blab({ id: 11 })]);

    expect(rows[0]).toMatchObject({ handle: 'ada', display_name: 'Ada', avatar: 'a.png' });
    expect(rows[1]).toMatchObject({ handle: 'ada', display_name: 'Ada', avatar: 'a.png' });
  });

  it('never selects the author citizenid', async () => {
    // The whole reason `publicColumns` withholds Blabber's own: a public read returns rows the
    // reader does not own, and with several accounts per player the owner's citizenid correlates
    // an alt back to whoever holds it. A join is the other route to the same disclosure.
    await repo.hydrate([blab()]);

    const sql = String(dbMock.query.mock.calls[0][0]);
    expect(sql).toContain('gphone_accounts');
    expect(sql).not.toContain('citizenid');
  });

  it('reads the whole page in one query, deduplicated by account', async () => {
    // Per row this would be thirty round trips for one feed page. `MessageRepository` batches
    // its attachment join for the same reason.
    const rows = Array.from({ length: 30 }, (_, i) => blab({ id: i + 1, account_id: (i % 2) + 1 }));

    await repo.hydrate(rows);

    expect(dbMock.query).toHaveBeenCalledTimes(1);
    expect(dbMock.query.mock.calls[0][1]).toEqual([1, 2]);
  });

  it('queries nothing at all for an empty page', async () => {
    await expect(repo.hydrate([])).resolves.toEqual([]);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('hydrates the quoted Blab, and its author, in the same pass', async () => {
    dbMock.query
      .mockResolvedValueOnce([blab({ id: 9, account_id: 2, body: 'the original' })])
      .mockResolvedValueOnce([author(1, 'ada'), author(2, 'bob', { display_name: 'Bob' })]);

    const [row] = await repo.hydrate([blab({ id: 20, account_id: 1, mouth_of: 9 })]);

    expect(row.handle).toBe('ada');
    expect(row.mouthed).toMatchObject({ id: 9, handle: 'bob', display_name: 'Bob' });
    // Both pages of authors in one read: a quote is usually somebody else's, so splitting this
    // would double the query count on any feed with mouths in it.
    expect(dbMock.query).toHaveBeenCalledTimes(2);
    expect(dbMock.query.mock.calls[1][1]).toEqual([1, 2]);
  });

  it('reads the quoted Blab through the public projection', async () => {
    dbMock.query.mockResolvedValueOnce([blab({ id: 9, account_id: 2 })]).mockResolvedValueOnce([]);

    await repo.hydrate([blab({ id: 20, mouth_of: 9 })]);

    const sql = String(dbMock.query.mock.calls[0][0]);
    expect(sql).not.toContain('citizenid');
    expect(sql).toContain("`status` = 'active'");
  });

  it('leaves the quote empty when the Blab it mouths is gone', async () => {
    // A moderated or deleted target drops out of the projection. Null rather than a stale card:
    // the row should say it mouthed something and show nothing, not show removed content.
    dbMock.query.mockResolvedValueOnce([]).mockResolvedValueOnce([author(1, 'ada')]);

    const [row] = await repo.hydrate([blab({ id: 20, account_id: 1, mouth_of: 9 })]);

    expect(row.mouthed).toBeNull();
    expect(row.handle).toBe('ada');
  });

  it('leaves a row alone when its account has vanished', async () => {
    // Rather than throwing and taking the whole page down with it.
    dbMock.query.mockResolvedValueOnce([]);

    const [row] = await repo.hydrate([blab({ id: 10, account_id: 404 })]);

    expect(row.handle).toBeUndefined();
  });

  it('hydrates a profile feed through the same path as the public one', async () => {
    // `blabber:profile` builds its projection by hand, so it was the read most able to disagree
    // with the feed about what an author looks like — and did, carrying no author at all.
    dbMock.query
      .mockResolvedValueOnce([blab({ id: 5, account_id: 1 })])
      .mockResolvedValueOnce([author(1, 'ada', { display_name: 'Ada' })]);

    const reply = await call('profile', { account_id: 1, tab: 'blabs' });

    expect(reply.rows[0]).toMatchObject({ id: 5, handle: 'ada', display_name: 'Ada' });
  });

  it("carries the quoted Blab in create's echo", async () => {
    // The client prepends the echo straight into the feed, so anything missing here renders
    // blank until the next fetch. This used to be grafted on client-side from whatever was in
    // the local window, which showed nothing for a Blab mouthed from a profile or a thread.
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.single.mockResolvedValueOnce({ id: 9, status: 'active' });
    dbMock.query
      .mockResolvedValueOnce([blab({ id: 9, account_id: 2, body: 'the original' })])
      .mockResolvedValueOnce([author(2, 'bob', { display_name: 'Bob' })]);

    const reply = await call('create', { account_id: 1, mouth_of: 9 });

    expect(reply.mouthed).toMatchObject({ id: 9, handle: 'bob' });
  });
});

/**
 * One Blab by id — what a deep link resolves through.
 *
 * A notification names an id and nothing else, so without this the app opened a thread around a
 * stub and rendered a blank post above its replies. The generic `get` cannot answer it: `id` is
 * framework-supplied and never `clientFilterable`, and a public read is paged rather than
 * addressed.
 */
describe('blabber:view', () => {
  it('resolves the root and returns it with the flattened, hydrated replies', async () => {
    dbMock.single.mockResolvedValueOnce(blab({ id: 7, account_id: 2, body: 'root post' })); // root lookup
    // The root is always resolved through `findPublicById` — never handed back as the raw
    // `findById` row — so it costs its own `selectPublic` + author query up front, distinct
    // from the replies page's own author batch.
    dbMock.query
      .mockResolvedValueOnce([blab({ id: 7, account_id: 2, body: 'root post' })]) // selectPublic([7]) for the root
      .mockResolvedValueOnce([author(2, 'ada')]) // root's own author
      .mockResolvedValueOnce([blab({ id: 9, account_id: 3, root_id: 7 })]) // replies
      .mockResolvedValueOnce([author(3, 'bob')]); // replies' authors

    const reply = await call('view', { id: 7 });

    expect(reply.root).toMatchObject({ id: 7, handle: 'ada' });
    expect(reply.replies).toHaveLength(1);
    expect(reply.replies[0]).toMatchObject({ id: 9, handle: 'bob' });
  });

  it('never returns the root author citizenid, even when the requested id is the root itself', async () => {
    // The trap this regresses: `findById` (used to resolve `requested`) is `SELECT *` and
    // carries `citizenid`. When the requested id IS the root — every feed tap, every top-level
    // deep link — the old code handed that raw row back as `root` unchanged.
    dbMock.single.mockResolvedValueOnce(
      blab({ id: 7, account_id: 2, body: 'root post', citizenid: 'CIT_ROOT_OWNER' })
    );
    dbMock.query
      .mockResolvedValueOnce([blab({ id: 7, account_id: 2, body: 'root post' })]) // selectPublic([7]) — no citizenid column
      .mockResolvedValueOnce([author(2, 'ada')]) // root's own author
      .mockResolvedValueOnce([]); // flattened replies — empty, so hydrate never queries again

    const reply = await call('view', { id: 7 });

    expect(reply.root).not.toBeNull();
    expect(reply.root.citizenid).toBeUndefined();
  });

  it('resolves the root from a reply id, not just a top-level id', async () => {
    // The requested id (9) is itself a reply, root_id 7.
    dbMock.single.mockResolvedValueOnce(blab({ id: 9, account_id: 3, root_id: 7 }));
    // Root fetch (id 7) once the true root is known.
    dbMock.query
      .mockResolvedValueOnce([blab({ id: 7, account_id: 2 })]) // selectPublic([7]) for the root
      .mockResolvedValueOnce([]) // its author
      .mockResolvedValueOnce([blab({ id: 9, account_id: 3, root_id: 7 })]) // flattened replies
      .mockResolvedValueOnce([]); // reply authors

    const reply = await call('view', { id: 9 });

    expect(reply.root).toMatchObject({ id: 7 });
    expect(reply.replies.map((r: any) => r.id)).toContain(9);
  });

  it('answers root: null for a deleted or moderated id, rather than throwing', async () => {
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('view', { id: 999 });

    expect(reply.root).toBeNull();
    expect(reply.replies).toEqual([]);
  });

  it('refuses a non-positive id', async () => {
    const reply = await call('view', { id: -1 });
    expect(reply.error).toBeTruthy();
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('ignores an anchorId that does not belong to the resolved subtree', async () => {
    dbMock.single.mockResolvedValueOnce(blab({ id: 7, account_id: 2 }));
    // membership check for the bogus anchor fails
    dbMock.single.mockResolvedValueOnce(null);
    dbMock.query
      .mockResolvedValueOnce([blab({ id: 7, account_id: 2 })]) // selectPublic([7]) for the root
      .mockResolvedValueOnce([]) // root's own author
      .mockResolvedValueOnce([]); // flattened replies (empty, no anchor split)

    await call('view', { id: 7, anchorId: 4242 });

    /**
     * A rejected anchor must fall back to plain-cursor mode: one `Database.query` for the
     * flattened replies (empty here) rather than the two-query newer/older anchor split. The
     * other two calls below are the root's own resolution through `findPublicById`
     * (`selectPublic` + its author batch), which runs regardless of the anchor outcome. What
     * proves the split never ran is that none of the three calls' SQL orders `ASC` — the anchor
     * split's "newer" half is the only query in this file that does.
     */
    expect(dbMock.query).toHaveBeenCalledTimes(3);
    for (const [sql] of dbMock.query.mock.calls) {
      expect(String(sql)).not.toMatch(/ORDER BY `id` ASC/);
    }
  });
});

describe('engagement', () => {
  it('answers nothing for an empty id list without querying', async () => {
    await expect(call('engagement', { ids: [] })).resolves.toEqual({});
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('caps the number of ids it will answer for', async () => {
    // The ids become a placeholder list, so an unbounded array is both injection-shaped and a
    // way to ask for one enormous query (§2.9).
    dbMock.query.mockResolvedValue([]);

    await call('engagement', { ids: Array.from({ length: 500 }, (_, i) => i + 1) });

    // First query is the caller's own accounts; the counts follow with the capped list.
    const countCall = dbMock.query.mock.calls[1];
    expect((countCall[1] as unknown[]).length).toBe(60);
  });

  it('drops ids that are not positive integers rather than failing the page', async () => {
    dbMock.query.mockResolvedValue([]);

    await call('engagement', { ids: [1, 'x', -2, 0, 3.5, 4] });

    const countCall = dbMock.query.mock.calls[1];
    expect(countCall[1]).toEqual([1, 4]);
  });

  it('reports zeroes for a Blab nothing has happened to', async () => {
    dbMock.query.mockResolvedValue([]);

    const reply = await call('engagement', { ids: [7] });

    expect(reply[7]).toEqual({
      replies: 0,
      mouths: 0,
      ears: 0,
      earedByMe: false,
      mouthedByMe: false
    });
  });
});

/**
 * The Following feed.
 *
 * A custom action because the generic filter compares a column to a value and this needs a set
 * the database looks up. The two things worth pinning are that it is scoped to an account the
 * caller actually owns — the id arrives in a payload, and a payload is not proof of intent
 * (§2.9) — and that it pages by the same keyset rule as every other read, since a client paging
 * two ways will get one of them wrong.
 */
describe('the Following feed', () => {
  it('refuses an account the caller does not own', async () => {
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call('following', { account_id: 99 });

    expect(reply.error).toMatch(/not yours/);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('reads only the accounts that account follows, as a subquery', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.query.mockResolvedValueOnce([]);

    await call('following', { account_id: 1 });

    const [sql, params] = dbMock.query.mock.calls[0];
    // A subquery rather than a join: a join emits one row per matching follow row, so the feed
    // would duplicate a post if the graph ever held a duplicate.
    expect(sql).toMatch(/IN \(\s*SELECT `followee_account_id`/);
    expect(sql).toMatch(/`follower_account_id` = \?/);
    // The verified account, never the id from the payload.
    expect(params[0]).toBe(MY_ACCOUNT.id);
  });

  it('never selects the author citizenid', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.query.mockResolvedValueOnce([]);

    await call('following', { account_id: 1 });

    expect(dbMock.query.mock.calls[0][0]).not.toContain('citizenid');
  });

  it('is top-level only, like the public feed', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.query.mockResolvedValueOnce([]);

    await call('following', { account_id: 1 });

    // A timeline with replies mixed in shows half a conversation with nothing to open.
    expect(dbMock.query.mock.calls[0][0]).toContain('`reply_to` IS NULL');
  });

  it('pages on id DESC and reports the end as null', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.query.mockResolvedValueOnce([blab({ id: 9 }), blab({ id: 8 })]);
    // Hydration's author lookup.
    dbMock.query.mockResolvedValueOnce([author(1, 'ada')]);

    const reply = await call('following', { account_id: 1, limit: 5 });

    expect(dbMock.query.mock.calls[0][0]).toContain('ORDER BY `id` DESC');
    // Two rows against a limit of five, so there is no further page.
    expect(reply.nextCursor).toBeNull();
    expect(reply.rows).toHaveLength(2);
  });

  it('asks for one row more than the page, and does not return the probe', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.query.mockResolvedValueOnce([blab({ id: 9 }), blab({ id: 8 }), blab({ id: 7 })]);
    dbMock.query.mockResolvedValueOnce([author(1, 'ada')]);

    const reply = await call('following', { account_id: 1, limit: 2 });

    // limit + 1: the extra row exists only to answer "is there more" and is never delivered.
    expect(dbMock.query.mock.calls[0][1].at(-1)).toBe(3);
    expect(reply.rows.map((row: any) => row.id)).toEqual([9, 8]);
    expect(reply.nextCursor).toBe(8);
  });

  it('clamps an over-large page rather than refusing it', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.query.mockResolvedValueOnce([]);

    await call('following', { account_id: 1, limit: 5000 });

    // The request is legitimate; only the number is not.
    expect(dbMock.query.mock.calls[0][1].at(-1)).toBe(61);
  });

  it('binds the cursor rather than interpolating it', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);
    dbMock.query.mockResolvedValueOnce([]);

    await call('following', { account_id: 1, cursor: 42 });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(sql).toContain('`id` < ?');
    expect(params).toContain(42);
  });

  it('rejects a cursor that is not a positive integer', async () => {
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    const reply = await call('following', { account_id: 1, cursor: 'DROP' });

    expect(reply.error).toBeTruthy();
    expect(dbMock.query).not.toHaveBeenCalled();
  });
});

describe('blabber:search', () => {
  it('matches body text, replies included', async () => {
    dbMock.query
      .mockResolvedValueOnce([
        blab({ id: 8, account_id: 1, body: 'the traffic here is unreal', reply_to: 3 })
      ])
      .mockResolvedValueOnce([author(1, 'ada')]);

    const reply = await call('search', { q: 'traffic' });

    expect(reply.rows).toHaveLength(1);
    expect(reply.rows[0]).toMatchObject({ id: 8, reply_to: 3, handle: 'ada' });
  });

  it('binds the query rather than interpolating it', async () => {
    await call('search', { q: "x' OR '1'='1" });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).not.toContain("OR '1'='1");
    expect(params).toContain(`%x' OR '1'='1%`);
  });

  it('never returns an author citizenid', async () => {
    dbMock.query.mockResolvedValueOnce([blab({ id: 8 })]).mockResolvedValueOnce([author(1, 'ada')]);

    await call('search', { q: 'anything' });

    for (const [sql] of dbMock.query.mock.calls) {
      expect(String(sql)).not.toContain('citizenid');
    }
  });
});

describe('blabber:searchTags', () => {
  it('prefix-matches tag names with usage counts', async () => {
    dbMock.query.mockResolvedValueOnce([
      { tag: 'losangeles', uses: 12 },
      { tag: 'losfeliz', uses: 3 }
    ]);

    const reply = await call('searchTags', { q: 'los' });

    expect(reply.rows).toEqual([
      { tag: 'losangeles', uses: 12 },
      { tag: 'losfeliz', uses: 3 }
    ]);
    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('LIKE');
    expect(params).toContain('los%');
  });
});

describe('blabber:byTag', () => {
  it('returns Blabs carrying the exact tag, not a substring match', async () => {
    dbMock.query
      .mockResolvedValueOnce([blab({ id: 8, account_id: 1 })])
      .mockResolvedValueOnce([author(1, 'ada')]);

    const reply = await call('byTag', { tag: 'car' });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('t.`tag` = ?');
    expect(params).toContain('car');
    expect(reply.rows).toHaveLength(1);
  });

  it('requires a tag', async () => {
    const reply = await call('byTag', {});
    expect(reply.error).toBeTruthy();
  });
});

describe('blabber:trendingTags', () => {
  it('returns the top tags from the last 48 hours', async () => {
    dbMock.query.mockResolvedValueOnce([{ tag: 'losangeles', uses: 40 }]);

    const reply = await call('trendingTags', {});

    expect(reply).toEqual([{ tag: 'losangeles', uses: 40 }]);
    const sql = String(dbMock.query.mock.calls[0][0]);
    expect(sql).toContain('INTERVAL 48 HOUR');
    expect(sql).toContain('LIMIT 10');
  });
});
