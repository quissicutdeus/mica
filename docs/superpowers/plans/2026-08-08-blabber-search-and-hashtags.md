# Blabber: Search, Hashtags, and a Flattened Blab View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Blabber's fourth nav tab (Search, over people/Blabs/tags), make hashtags tappable
and indexed, and replace the current unbounded-depth `Thread` view with one flattened screen per
Blab that every entry point — feed, search, tag, deep link — opens the same way.

**Architecture:** A new `root_id` column on `gphone_blabber`, set once at create and inherited from
the parent (never walked or recursively queried), makes "flatten this subtree" and "find this
reply's top-level ancestor" both O(1). Five new/changed server actions (`blabber:view`,
`accounts:search`, `blabber:search`, `blabber:searchTags`, `blabber:byTag`, `blabber:trendingTags`)
sit on the existing `defineService`/`Repository` machinery. The client collapses its current
`threads: Blab[]` navigation stack to a single `activeBlabId`, since there is no longer a second
level to drill into.

**Tech Stack:** Svelte 5 (runes, component-local state only — AGENTS.md §4), TypeScript, Vitest,
Playwright, MySQL/MariaDB via oxmysql.

## Global Constraints

- No mutating git without being asked (AGENTS.md §2.1) — this plan stages and lets the user commit,
  matching how the two prior sessions on this feature worked.
- Never interpolate a payload value into SQL; every `q`/`tag`/id is bound (§2.9).
- A public read (`read: 'public'`) requires `paging`; `defineService` throws without it (§10).
- `pnpm typecheck`, not `typecheck:web` alone — three targets run different TypeScript versions
  (§3).
- `Database` is mocked in every server test (`vi.mock('../lib/Database', ...)`) — never a real
  connection.
- Definition of done (§9): `pnpm typecheck`, `pnpm test:unit`, `pnpm test:e2e` (this touches
  `web/`), `pnpm format:check`, all passing, before any task is reported complete.
- Comments explain *why*, never *what* — match the existing file's voice; do not restate the
  obvious.
- The design spec is `docs/superpowers/specs/2026-08-08-blabber-search-and-hashtags-design.md`.
  Where this plan and that spec ever disagree, the spec is the source of intent — flag it rather
  than silently picking one.

---

## File Map

| File | Change |
| --- | --- |
| `shared/types.ts` | `Blab.root_id?: number \| null` |
| `shared/richText.ts` | new `taggedTopics()` |
| `shared/richText.test.ts` | new tests for `taggedTopics` |
| `server/services/Blabber.ts` | `root_id` schema field + `childTables` tags table; `create` sets `root_id` and inserts tags; new actions `view` (replaces `blab`), `search`, `searchTags`, `byTag`, `trendingTags` |
| `server/repositories/BlabberRepository.ts` | `findFlattenedPage()` |
| `server/services/Accounts.ts` | new `search` action |
| `server/__tests__/blabber.test.ts` | tests for all of the above |
| `server/__tests__/accountsSearch.test.ts` | new — tests for `accounts:search` |
| `sql/` | `pnpm generate:sql` regenerates `gphone.sql` (no hand file to write) |
| `web/src/apps/blabber/store.ts` | `viewBlab`, four search stores, `trendingTags`, `loadTaggedBlabs`; removes `loadBlab`/`loadThread` |
| `web/src/apps/blabber/store.test.ts` | tests for the above |
| `web/src/apps/blabber/components/BlabDetail.svelte` | new — replaces `Thread.svelte` |
| `web/src/apps/blabber/components/Thread.svelte` | deleted |
| `web/src/apps/blabber/components/BlabBody.svelte` | tag `<span>` → `<button>`, `ontag` prop |
| `web/src/apps/blabber/components/BlabRow.svelte` | thread `ontag` through to `BlabBody` |
| `web/src/apps/blabber/components/Messages.svelte` | thread `ontag` through to `BlabBody` |
| `web/src/apps/blabber/components/TaggedFeed.svelte` | new — the screen a tag tap lands on |
| `web/src/apps/blabber/components/Search.svelte` | new — the Search tab |
| `web/src/apps/blabber/index.svelte` | drop `threads` stack for `activeBlabId`; wire `BlabDetail`, `TaggedFeed`, `Search`; fourth `TabBar` entry; `useAppLevels` rung simplification |
| `web/src/sdk/ui/SearchBar.svelte` | fix `use:focus` stub |
| `web/src/nui/mocks/registry.ts` | mocks for every new/changed action |
| `web/e2e/apps/blabber.spec.ts` | new e2e cases |
| `docs/roadmap.md` | Search/hashtags moves *Proposed* → *Shipped* |
| `web/README.md`, `README.md` | checked per spec's "Docs to update" section, edited if stale |

---

## Task 1: `taggedTopics()` in `shared/richText.ts`

**Files:**
- Modify: `shared/richText.ts`
- Test: `shared/richText.test.ts` (new file — none exists yet for this module)

**Interfaces:**
- Produces: `taggedTopics(input: string): string[]` — lowercased, deduplicated tag values (no `#`),
  in first-appearance order. Consumed by Task 3 (`create`'s tag-insert) and by nothing else.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { taggedTopics, mentionedHandles, tokenizeRichText } from './richText';

describe('taggedTopics', () => {
  it('extracts hashtags, lowercased and deduplicated', () => {
    expect(taggedTopics('Loving #LosAngeles today, #losangeles never disappoints')).toEqual([
      'losangeles'
    ]);
  });

  it('ignores mentions and plain text', () => {
    expect(taggedTopics('@ada said hi, no tags here')).toEqual([]);
  });

  it('returns tags in first-appearance order', () => {
    expect(taggedTopics('#one #two #three')).toEqual(['one', 'two', 'three']);
  });

  it('returns an empty array for empty input', () => {
    expect(taggedTopics('')).toEqual([]);
  });

  it('agrees with tokenizeRichText about what counts as a tag', () => {
    const body = 'traffic on the interstate #losangeles is unreal #traffic';
    const fromTokens = tokenizeRichText(body)
      .filter((t) => t.kind === 'tag')
      .map((t) => t.value);
    expect(taggedTopics(body)).toEqual([...new Set(fromTokens)]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/../../shared/richText.test.ts` — actually run from repo
root: `pnpm test:unit:web -- richText` (Vitest's web project includes `shared/` via the
`@shared/types` path alias used elsewhere; confirm the file is picked up by the `web` project's
glob before relying on this — if it is not, place the test beside `shared/richText.ts` and add it
to whichever Vitest project's include pattern already covers `shared/` test files. Check
`web/vite.config.ts`'s `test.include` first.)

Expected: FAIL — `taggedTopics` is not exported.

- [ ] **Step 3: Write the implementation**

Add directly below `mentionedHandles` in `shared/richText.ts`:

```ts
/**
 * Every hashtag in a message, lowercased, deduplicated, first-appearance order.
 *
 * A sibling of `mentionedHandles` for the same reason that one lives here: what `BlabBody`
 * highlights and what gets indexed for search must come from the same tokenizer, or a tag that
 * lights up in the UI and a tag that search can never find are two different definitions of one
 * word.
 */
export function taggedTopics(input: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenizeRichText(input)) {
    if (token.kind === 'tag') seen.add(token.value);
  }
  return [...seen];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run the same command as Step 2. Expected: PASS, all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add shared/richText.ts shared/richText.test.ts
git commit -m "feat(blabber): add taggedTopics, a sibling of mentionedHandles"
```

---

## Task 2: `root_id` on `gphone_blabber` — schema, type, and `create`

**Files:**
- Modify: `shared/types.ts` (`Blab` interface)
- Modify: `server/services/Blabber.ts` (schema + `create` handler)
- Test: `server/__tests__/blabber.test.ts`

**Interfaces:**
- Produces: `Blab.root_id: number | null | undefined` (optional, like every other hydrated/derived
  field on this type). Consumed by Task 4 (`findFlattenedPage`) and Task 5 (`blabber:view`).
- Consumes: nothing new — `visibleTarget` (existing, `server/services/Blabber.ts:233`) already
  returns a full row via `repo.findById`, which selects `*`, so `target.root_id` is available the
  moment the column exists.

- [ ] **Step 1: Add the field to the shared type**

In `shared/types.ts`, inside `interface Blab` (currently lines 199–218), add after `mouth_of`:

```ts
  /** The top-level ancestor of this Blab's reply chain, or null if this Blab *is* top-level. */
  root_id?: number | null;
```

- [ ] **Step 2: Write the failing server test**

In `server/__tests__/blabber.test.ts`, add a new `describe` block. Place it after the existing
`describe('posting', ...)` block:

```ts
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

    const values = dbMock.insert.mock.calls[0][1] as unknown[];
    // Root is 9 (the true top-level ancestor), never 12 (the immediate parent).
    expect(values).toContain(9);
    expect(values).not.toContain(12);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test:unit:server -- blabber`
Expected: FAIL — `root_id` is not a declared column, so `columns` never contains it and the create
handler never sets it.

- [ ] **Step 4: Declare the column**

In `server/services/Blabber.ts`, inside the `schema` block (after `mouth_of`, currently ending
around line 91), add:

```ts
    /**
     * The top-level ancestor of this Blab's reply chain, or null if this Blab is itself
     * top-level. Set once at create (below) from the parent's own `root_id` — never from a
     * walk up `reply_to`, and never mutated afterward. Same discipline as `reply_to` and
     * `mouth_of`: a self-reference fixed at creation, so "flatten this thread" and "find a
     * reply's top-level ancestor" are both a single indexed lookup rather than a recursive
     * query. See docs/superpowers/specs/2026-08-08-blabber-search-and-hashtags-design.md.
     */
    root_id: {
      type: 'int',
      clientWritable: false,
      clientFilterable: true,
      references: { table: 'gphone_blabber', column: 'id' }
    }
```

Add an index — every flattened-view read filters on it:

```ts
    { name: 'root_id', columns: ['root_id'] }
```

(add this entry to the existing `indexes` array, alongside `account_id` and `reply_to`.)

- [ ] **Step 5: Set it in `create`**

In `server/services/Blabber.ts`'s `create` handler (currently lines 242–274), the `replyTo`
resolution reads:

```ts
  const replyTo =
    body.reply_to === undefined || body.reply_to === null
      ? null
      : (await visibleTarget(body.reply_to, 'reply target')).id;
```

Change this so the parent row is held (not just its `.id`), and derive `rootId` from it:

```ts
  const replyParent =
    body.reply_to === undefined || body.reply_to === null
      ? null
      : await visibleTarget(body.reply_to, 'reply target');
  const replyTo = replyParent?.id ?? null;
  // Inherited, never walked: the parent is either top-level (root_id null, so it becomes the
  // root) or itself a reply (root_id already the true top-level ancestor, so it passes through
  // unchanged). Either way this is one lookup already in hand, not a second query.
  const rootId = replyParent === null ? null : (replyParent.root_id ?? replyParent.id);
```

And in the `repo.create({...})` call a few lines down, add `root_id: rootId`:

```ts
    const id = await repo.create({
      citizenid,
      account_id: account.id,
      body: text || null,
      reply_to: replyTo,
      mouth_of: mouthOf,
      root_id: rootId
    } as Partial<Blab>);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test:unit:server -- blabber`
Expected: PASS, all three new cases plus every pre-existing `create` test (they still pass because
`root_id` being an additional bound column doesn't change any existing assertion's shape — verify
this by running the whole file, not just the new block).

- [ ] **Step 7: Regenerate the SQL and typecheck**

Run: `pnpm generate:sql`
Expected: `gphone.sql` diffs to include `root_id` and its index on `gphone_blabber`. Review the
diff — it should touch only that table's `CREATE TABLE` and nothing else.

Run: `pnpm typecheck`
Expected: PASS (the `Blab.root_id` field is optional, so nothing that constructs a `Blab` without
it breaks).

- [ ] **Step 8: Commit**

```bash
git add shared/types.ts server/services/Blabber.ts server/__tests__/blabber.test.ts gphone.sql
git commit -m "feat(blabber): add root_id, inherited at create, for O(1) thread flattening"
```

---

## Task 3: `gphone_blabber_tags` child table, written at create

**Files:**
- Modify: `server/services/Blabber.ts` (childTables + tag insert in `create`)
- Test: `server/__tests__/blabber.test.ts`

**Interfaces:**
- Consumes: `taggedTopics` from Task 1.
- Produces: the `gphone_blabber_tags` table (`blab_id`, `tag`), populated at create. Consumed by
  Task 6 (`blabber:searchTags`), Task 7 (`blabber:byTag`), Task 8 (`blabber:trendingTags`).

- [ ] **Step 1: Write the failing test**

Add to `server/__tests__/blabber.test.ts`, in a new `describe('hashtag indexing', ...)` block:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit:server -- blabber`
Expected: FAIL — no insert touches `gphone_blabber_tags` yet.

- [ ] **Step 3: Declare the child table**

In `server/services/Blabber.ts`, inside the `childTables` array (currently one entry,
`gphone_blabber_likes`), add a second entry:

```ts
    {
      name: 'gphone_blabber_tags',
      columns: {
        blab_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_blabber', column: 'id' }
        },
        tag: { type: 'string', length: 32, notNull: true }
      },
      indexes: [
        { name: 'tag', columns: ['tag'] },
        { name: 'blab_id', columns: ['blab_id'] }
      ]
    }
```

- [ ] **Step 4: Import `taggedTopics` and write the rows in `create`**

At the top of `server/services/Blabber.ts`, extend the existing `richText` import:

```ts
import { mentionedHandles, taggedTopics } from '@shared/richText';
```

In the `create` handler, after `const id = await repo.create({...})` succeeds and before the
`notifyMentions` call, insert:

```ts
    /**
     * Fixed at creation, never re-extracted on edit — the 15-minute edit window (§10) is framed
     * as a typo fix, not a rewrite, and re-indexing on every edit would be work for a case this
     * app doesn't have.
     *
     * Never allowed to fail the post, same discipline as the mention notification just below:
     * the Blab is committed either way.
     */
    const tags = taggedTopics(text).slice(0, 20);
    if (tags.length > 0) {
      void Promise.all(
        tags.map((tag) =>
          Database.insert('INSERT INTO `gphone_blabber_tags` (`blab_id`, `tag`) VALUES (?, ?)', [
            id,
            tag
          ])
        )
      ).catch((error) => console.error('[blabber] Tag indexing failed for', id, error));
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:unit:server -- blabber`
Expected: PASS.

- [ ] **Step 6: Regenerate SQL, typecheck**

Run: `pnpm generate:sql` — review the diff adds `gphone_blabber_tags` after `gphone_blabber` (child
tables emit after their parent, per §10).

Run: `pnpm typecheck` — expect PASS.

- [ ] **Step 7: Commit**

```bash
git add server/services/Blabber.ts server/__tests__/blabber.test.ts gphone.sql
git commit -m "feat(blabber): index hashtags into gphone_blabber_tags at create"
```

---

## Task 4: `BlabberRepository.findFlattenedPage`

**Files:**
- Modify: `server/repositories/BlabberRepository.ts`
- Test: new file `server/__tests__/blabberRepository.test.ts`

**Interfaces:**
- Produces: `findFlattenedPage(rootId: number, opts: { limit: number; cursor: number | null;
  anchorId: number | null }): Promise<{ rows: Blab[]; nextCursor: number | null }>`. Consumed by
  Task 5 (`blabber:view`).

This is the query engine behind "flatten a subtree" and the anchor-centered window from the spec.
No existing test file covers `BlabberRepository` directly — `blabber.test.ts` exercises it only
through the registered actions — so this task's tests talk to the repository class directly, the
way `server/__tests__/blabber.test.ts`'s `describe('author hydration', ...)` block already does
via `repo.hydrate(...)`.

- [ ] **Step 1: Write the failing test**

```ts
// server/__tests__/blabberRepository.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  query: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  scalar: vi.fn(),
  single: vi.fn()
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { blabber } from '../services/Blabber';
import type { BlabberRepository } from '../repositories/BlabberRepository';

const repo = blabber.repo as BlabberRepository;

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  account_id: 1,
  body: `blab ${id}`,
  reply_to: null,
  mouth_of: null,
  root_id: 100,
  status: 'active',
  ...over
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
});

describe('findFlattenedPage', () => {
  it('without a cursor or anchor, returns the newest replies first', async () => {
    dbMock.query
      .mockResolvedValueOnce([row(105), row(104), row(103)]) // replies (author query separate)
      .mockResolvedValueOnce([]); // author lookup, no authors needed for this assertion

    const page = await repo.findFlattenedPage(100, { limit: 30, cursor: null, anchorId: null });

    expect(page.rows.map((r) => r.id)).toEqual([105, 104, 103]);
    expect(page.nextCursor).toBeNull();

    const sql = String(dbMock.query.mock.calls[0][0]);
    expect(sql).toContain('root_id');
    expect(sql).not.toContain('reply_to');
  });

  it('paginates with nextCursor when more rows exist than the limit', async () => {
    // limit 2 requested; repository asks for limit+1 to detect more.
    dbMock.query.mockResolvedValueOnce([row(105), row(104), row(103)]).mockResolvedValueOnce([]);

    const page = await repo.findFlattenedPage(100, { limit: 2, cursor: null, anchorId: null });

    expect(page.rows.map((r) => r.id)).toEqual([105, 104]);
    expect(page.nextCursor).toBe(104);
  });

  it('honors a cursor for a continuation page, ignoring any anchor', async () => {
    dbMock.query.mockResolvedValueOnce([row(102), row(101)]).mockResolvedValueOnce([]);

    await repo.findFlattenedPage(100, { limit: 30, cursor: 103, anchorId: 999 });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('id` < ?');
    expect(params).toContain(103);
  });

  it('with an anchor and no cursor, centers the window on the anchor row', async () => {
    // First call: rows newer than the anchor, ascending. Second call: the anchor and older,
    // descending. Third call: authors.
    dbMock.query
      .mockResolvedValueOnce([row(101), row(102)]) // newer than anchor 100 request... see note
      .mockResolvedValueOnce([row(100), row(99), row(98)]) // anchor (100) and older
      .mockResolvedValueOnce([]); // authors

    const page = await repo.findFlattenedPage(100, { limit: 6, cursor: null, anchorId: 100 });

    // Merged back into id DESC: newer (reversed to descending) then the anchor-and-older page.
    expect(page.rows.map((r) => r.id)).toEqual([102, 101, 100, 99, 98]);
  });
});
```

**Note on the anchor test:** the exact row ids in the fixtures are illustrative — what the test
must pin down is the *shape*: two queries (newer-ascending, anchor-and-older-descending), merged
back into one `id DESC` list with the anchor row present. Adjust the mocked return values if the
implementation's exact `LIMIT` split (Step 3 below) produces a different split point than assumed
here; the assertion that matters is `page.rows` ending up in descending order with `100` present.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit:server -- blabberRepository`
Expected: FAIL — `findFlattenedPage` does not exist.

- [ ] **Step 3: Implement it**

In `server/repositories/BlabberRepository.ts`, add a method (place it after `findPublicById`):

```ts
  /**
   * The flattened subtree under one root: every reply at any depth, `id DESC`, keyset-paged.
   *
   * Not a per-depth read — `root_id` already names the top-level ancestor regardless of how many
   * replies deep a row sits, so one `WHERE root_id = ?` covers the whole thread in a single
   * indexed query. See `root_id`'s declaration in `Blabber.ts` for why that column exists at all.
   *
   * `anchorId`, only honored when `cursor` is null (an initial open, never a "load older"
   * continuation): instead of the newest `limit` rows, the window is centered on the anchor row
   * so a reply search result — which can be arbitrarily old — is guaranteed present on the first
   * page rather than requiring the caller to page backward until they find it by hand.
   */
  async findFlattenedPage(
    rootId: number,
    opts: { limit: number; cursor: number | null; anchorId: number | null }
  ): Promise<{ rows: Blab[]; nextCursor: number | null }> {
    const { limit, cursor, anchorId } = opts;
    const projection = this.publicColumns.map((column) => `\`${column}\``).join(', ');
    const subtree = '(`id` = ? OR `root_id` = ?) AND `id` != ? AND `status` = \'active\'';

    let merged: Blab[];

    if (cursor !== null || anchorId === null) {
      const cursorClause = cursor === null ? '' : ' AND `id` < ?';
      const params: unknown[] = [rootId, rootId, rootId];
      if (cursor !== null) params.push(cursor);
      params.push(limit + 1);

      merged = await Database.query<Blab[]>(
        `SELECT ${projection} FROM \`${this.tableName}\`
         WHERE ${subtree}${cursorClause}
         ORDER BY \`id\` DESC
         LIMIT ?`,
        params
      );
    } else {
      const half = Math.ceil(limit / 2);

      const newer = await Database.query<Blab[]>(
        `SELECT ${projection} FROM \`${this.tableName}\`
         WHERE ${subtree} AND \`id\` > ?
         ORDER BY \`id\` ASC
         LIMIT ?`,
        [rootId, rootId, rootId, anchorId, half]
      );

      const older = await Database.query<Blab[]>(
        `SELECT ${projection} FROM \`${this.tableName}\`
         WHERE ${subtree} AND \`id\` <= ?
         ORDER BY \`id\` DESC
         LIMIT ?`,
        [rootId, rootId, rootId, anchorId, limit - newer.length + 1]
      );

      merged = [...newer.slice().reverse(), ...older];
    }

    const hasMore = merged.length > limit;
    const page = hasMore ? merged.slice(0, limit) : merged;
    return {
      rows: await this.hydrate(page),
      nextCursor: hasMore ? page[page.length - 1].id : null
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit:server -- blabberRepository`
Expected: PASS. If the anchor test's exact ids don't line up with the two-query split, adjust the
fixture values (not the implementation) until they describe the real query split, then re-run.

- [ ] **Step 5: Commit**

```bash
git add server/repositories/BlabberRepository.ts server/__tests__/blabberRepository.test.ts
git commit -m "feat(blabber): BlabberRepository.findFlattenedPage, with anchor windowing"
```

---

## Task 5: `blabber:view` — replaces `blab` and the ad-hoc `get{reply_to}` call

**Files:**
- Modify: `server/services/Blabber.ts`
- Test: `server/__tests__/blabber.test.ts`

**Interfaces:**
- Consumes: `repo.findFlattenedPage` (Task 4), `requirePositiveInt`, `pageBounds`.
- Produces: server action `blabber:view`, payload `{ id, cursor?, limit?, anchorId? }`, reply
  `{ root: Blab | null, replies: Blab[], nextCursor: number | null }`.
- Removes: the `blab` action added in the notifications-tab fix — do not leave both registered.

- [ ] **Step 1: Write the failing test**

In `server/__tests__/blabber.test.ts`, find the existing `describe('one Blab by id', ...)` block
(added for the `blab` action last session) and replace its contents — `view` supersedes it rather
than sitting alongside it:

```ts
describe('blabber:view', () => {
  it('resolves the root and returns it with the flattened, hydrated replies', async () => {
    dbMock.single.mockResolvedValueOnce(blab({ id: 7, account_id: 2, body: 'root post' })); // root lookup
    dbMock.query
      .mockResolvedValueOnce([blab({ id: 9, account_id: 3, root_id: 7 })]) // replies
      .mockResolvedValueOnce([author(2, 'ada'), author(3, 'bob')]); // authors

    const reply = await call('view', { id: 7 });

    expect(reply.root).toMatchObject({ id: 7, handle: 'ada' });
    expect(reply.replies).toHaveLength(1);
    expect(reply.replies[0]).toMatchObject({ id: 9, handle: 'bob' });
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
    dbMock.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await call('view', { id: 7, anchorId: 4242 });

    // The flattened query must have run in plain-cursor mode (one query for rows, not the
    // two-query anchor split) once the anchor was rejected.
    expect(dbMock.query).toHaveBeenCalledTimes(1 + 0); // rows query; authors query only if rows non-empty
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit:server -- blabber`
Expected: FAIL — no `view` action registered yet.

- [ ] **Step 3: Remove the old `blab` action, add `view`**

In `server/services/Blabber.ts`, delete the existing:

```ts
app.registerEvent('blab', async (source, cbId, data) => {
  const id = requirePositiveInt(fields(data).id, 'blab id');
  return await repo.findPublicById(id);
});
```

Replace it with:

```ts
/**
 * The one way to open a Blab. Every entry point — a feed tap, a search result, a tag tap, a
 * deep link — calls this and gets the same flattened screen: the root, then every reply at any
 * depth, `id DESC`, keyset-paged.
 *
 * Supersedes the earlier single-row `blab` action: that one answered "what is this row," which
 * left `Thread.svelte` making a second call for its direct replies and had no way to reach a
 * reply's own top-level ancestor at all.
 */
app.registerEvent('view', async (source, cbId, data) => {
  const body = fields(data);
  const id = requirePositiveInt(body.id, 'blab id');
  const { limit, cursor } = pageBounds(body, paging);

  const requested = await repo.findById(id);
  if (!requested || requested.status !== 'active') {
    return { root: null, replies: [], nextCursor: null };
  }

  const rootId = requested.root_id ?? requested.id;
  const root = rootId === requested.id ? requested : await repo.findPublicById(rootId);
  if (!root) return { root: null, replies: [], nextCursor: null };

  /**
   * `anchorId` only means anything as an initial open (no cursor) and only when it genuinely
   * belongs to this subtree — a payload value naming an unrelated Blab is not proof it applies
   * here (§2.9). `findById` rather than a second `findFlattenedPage` call: this only needs to
   * know the row exists and shares this root, not its hydrated shape.
   */
  const rawAnchor = body.anchorId;
  let anchorId: number | null = null;
  if (cursor === null && rawAnchor !== undefined && rawAnchor !== null) {
    const candidate = requirePositiveInt(rawAnchor, 'anchor id');
    const owns = await repo.findById(candidate);
    if (owns && (owns.id === rootId || owns.root_id === rootId)) anchorId = candidate;
  }

  const page = await repo.findFlattenedPage(rootId, { limit, cursor, anchorId });

  return { root: await repo.hydrate([root]).then((rows) => rows[0]), ...page };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit:server -- blabber`
Expected: PASS. If the mocked call-count in the "ignores an anchorId" test doesn't match the
implementation's actual query sequence, adjust the test's expected count to describe reality (the
requirement being verified is "the two-query anchor split does not run," not a specific number) —
do not change the implementation to hit an arbitrary count.

- [ ] **Step 5: Commit**

```bash
git add server/services/Blabber.ts server/__tests__/blabber.test.ts
git commit -m "feat(blabber): blabber:view — one flattened screen for any Blab, superseding blabber:blab"
```

---

## Task 6: `accounts:search`

**Files:**
- Modify: `server/services/Accounts.ts`
- Test: new file `server/__tests__/accountsSearch.test.ts`

**Interfaces:**
- Produces: server action `accounts:search`, payload `{ app, q, cursor?, limit? }`, reply
  `{ rows: Account[], nextCursor: number | null }`, `citizenid` never in a row (per `publicColumns`).

- [ ] **Step 1: Write the failing test**

```ts
// server/__tests__/accountsSearch.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, handlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  (globalThis as any).onNet = (event: string, handler: Function) => captured.set(event, handler);
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: 'CIT_A', source: 5, setMeta: () => {} }),
    getCitizenId: () => 'CIT_A',
    registerUsableItem: () => {}
  }
}));

import '../services/Accounts';

const call = async (data: unknown) => {
  const handler = handlers.get('gphone:server:accounts:search');
  if (!handler) throw new Error('accounts:search is not registered');
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls[0]?.[3];
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
});

describe('accounts:search', () => {
  it('binds the query rather than interpolating it', async () => {
    await call({ app: 'blabber', q: "ada' OR '1'='1" });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).not.toContain("OR '1'='1");
    expect(params).toContain(`%ada' OR '1'='1%`);
  });

  it('scopes to the requested app', async () => {
    await call({ app: 'blabber', q: 'ada' });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('`app` = ?');
    expect(params).toContain('blabber');
  });

  it('never selects citizenid', async () => {
    await call({ app: 'blabber', q: 'ada' });

    const sql = String(dbMock.query.mock.calls[0][0]);
    expect(sql).not.toContain('citizenid');
  });

  it('requires an app id', async () => {
    const reply = await call({ q: 'ada' });
    expect(reply.error).toBeTruthy();
  });

  it('paginates with a keyset cursor on id DESC', async () => {
    dbMock.query.mockResolvedValueOnce(
      Array.from({ length: 4 }, (_, i) => ({ id: 10 - i, handle: `h${i}` }))
    );

    const reply = await call({ app: 'blabber', q: 'ad', limit: 3 });

    expect(reply.rows).toHaveLength(3);
    expect(reply.nextCursor).toBe(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit:server -- accountsSearch`
Expected: FAIL — no `gphone:server:accounts:search` handler registered.

- [ ] **Step 3: Implement it**

In `server/services/Accounts.ts`, add after the existing `following` registration:

```ts
/**
 * Find an account by handle or display name, within one app.
 *
 * Placed here rather than on Blabber: identity is shared (`gphone_accounts`), and a future
 * social app gets the same search for free — the same reasoning `followers`/`following` are
 * declared here rather than per-app.
 *
 * Public, like every other account read: `citizenid` is withheld by `publicColumns`
 * automatically, so this cannot answer "which accounts belong to one player" — it answers "find
 * the account named X," the same fact a handle button anywhere in the app already exposes.
 */
app.registerEvent('search', async (source, cbId, data) => {
  const body = fields(data);
  const appId = optionalString(body.app);
  if (!appId) throw new Error('An app id is required.');

  const q = optionalString(body.q)?.slice(0, 64) ?? '';
  const { limit, cursor } = pageBounds(body, paging);

  const projection = accounts.resolved.publicColumns.map((column) => `\`${column}\``).join(', ');
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';
  const like = `%${q}%`;

  const params: unknown[] = [appId, like, like];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<Account[]>(
    `SELECT ${projection} FROM \`gphone_accounts\`
     WHERE \`app\` = ? AND \`status\` = 'active' AND (\`handle\` LIKE ? OR \`display_name\` LIKE ?)${cursorClause}
     ORDER BY \`id\` DESC
     LIMIT ?`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit:server -- accountsSearch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/Accounts.ts server/__tests__/accountsSearch.test.ts
git commit -m "feat(accounts): add search — the People segment of Blabber's Search tab"
```

---

## Task 7: `blabber:search` (body search, includes replies)

**Files:**
- Modify: `server/services/Blabber.ts`
- Test: `server/__tests__/blabber.test.ts`

**Interfaces:**
- Produces: server action `blabber:search`, payload `{ q, cursor?, limit? }`, reply
  `{ rows: Blab[], nextCursor: number | null }`. Unlike the feed/profile, no `reply_to` filter.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit:server -- blabber`
Expected: FAIL — no `search` action registered.

- [ ] **Step 3: Implement it**

Add to `server/services/Blabber.ts`, near `blabber:view`:

```ts
/**
 * Body search. Unlike the feed and Following, replies are included: a search answers "what was
 * said," not "what was said at the top level" — a matched reply opens through `view` like
 * everything else, landing on its flattened root screen.
 */
app.registerEvent('search', async (source, cbId, data) => {
  const body = fields(data);
  const q = optionalString(body.q)?.slice(0, 64) ?? '';
  const { limit, cursor } = pageBounds(body, paging);

  const projection = blabber.resolved.publicColumns.map((column) => `\`${column}\``).join(', ');
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';
  const like = `%${q}%`;

  const params: unknown[] = [like];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<Blab[]>(
    `SELECT ${projection} FROM \`gphone_blabber\`
     WHERE \`status\` = 'active' AND \`body\` LIKE ?${cursorClause}
     ORDER BY \`id\` DESC
     LIMIT ?`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { rows: await repo.hydrate(page), nextCursor: hasMore ? page[page.length - 1].id : null };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit:server -- blabber`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/Blabber.ts server/__tests__/blabber.test.ts
git commit -m "feat(blabber): add blabber:search — body search including replies"
```

---

## Task 8: `blabber:searchTags`, `blabber:byTag`, `blabber:trendingTags`

**Files:**
- Modify: `server/services/Blabber.ts`
- Test: `server/__tests__/blabber.test.ts`

**Interfaces:**
- Produces:
  - `blabber:searchTags` — `{ q, cursor?, limit? }` → `{ rows: { tag: string; uses: number }[],
    nextCursor: null }` (small, prefix-matched, not paged beyond one page — see implementation).
  - `blabber:byTag` — `{ tag, cursor?, limit? }` → `{ rows: Blab[], nextCursor: number | null }`.
  - `blabber:trendingTags` — no input → `{ tag: string; uses: number }[]`, top 10, 48h window.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit:server -- blabber`
Expected: FAIL — none of the three actions exist.

- [ ] **Step 3: Implement all three**

Add to `server/services/Blabber.ts`:

```ts
app.registerEvent('searchTags', async (source, cbId, data) => {
  const body = fields(data);
  const q = optionalString(body.q)?.slice(0, 32) ?? '';

  const rows = await Database.query<{ tag: string; uses: number }[]>(
    `SELECT \`tag\`, COUNT(*) AS uses FROM \`gphone_blabber_tags\`
     WHERE \`tag\` LIKE ?
     GROUP BY \`tag\`
     ORDER BY uses DESC
     LIMIT 20`,
    [`${q}%`]
  );

  // Not keyset-paged: a tag-name search answers a bounded autocomplete list, not a feed a
  // player scrolls to the bottom of.
  return { rows, nextCursor: null };
});

/**
 * Blabs carrying one exact tag — the shared landing spot for a Tags-search result, an inline
 * `#tag` tap, and a trending-chip tap. Exact match, never a substring: `#car` must not surface
 * `#cars` or `#carpet`.
 */
app.registerEvent('byTag', async (source, cbId, data) => {
  const body = fields(data);
  const tag = optionalString(body.tag);
  if (!tag) throw new Error('A tag is required.');

  const { limit, cursor } = pageBounds(body, paging);
  const projection = blabber.resolved.publicColumns
    .map((column) => `b.\`${column}\``)
    .join(', ');
  const cursorClause = cursor === null ? '' : ' AND b.`id` < ?';

  const params: unknown[] = [tag.toLowerCase()];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<Blab[]>(
    `SELECT ${projection} FROM \`gphone_blabber_tags\` t
     JOIN \`gphone_blabber\` b ON b.\`id\` = t.\`blab_id\`
     WHERE t.\`tag\` = ? AND b.\`status\` = 'active'${cursorClause}
     ORDER BY b.\`id\` DESC
     LIMIT ?`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { rows: await repo.hydrate(page), nextCursor: hasMore ? page[page.length - 1].id : null };
});

/**
 * A bounded snapshot, not a list a player pages through — no cursor.
 *
 * Recomputed per request rather than cached: a windowed aggregate over an indexed range is not
 * the per-row denormalized count AGENTS.md's "Blabber is the worked example" section warns
 * against.
 */
app.registerEvent('trendingTags', async () => {
  return await Database.query<{ tag: string; uses: number }[]>(
    `SELECT t.\`tag\`, COUNT(*) AS uses
     FROM \`gphone_blabber_tags\` t
     JOIN \`gphone_blabber\` b ON b.\`id\` = t.\`blab_id\`
     WHERE b.\`status\` = 'active' AND b.\`created_at\` > NOW() - INTERVAL 48 HOUR
     GROUP BY t.\`tag\`
     ORDER BY uses DESC
     LIMIT 10`
  );
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit:server -- blabber`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/Blabber.ts server/__tests__/blabber.test.ts
git commit -m "feat(blabber): searchTags, byTag, trendingTags"
```

---

## Task 9: Full server-side gate check

**Files:** none (verification only)

- [ ] **Step 1: Run the full server suite**

Run: `pnpm test:unit:server`
Expected: PASS, all files — including every pre-existing Blabber/Accounts test, to catch any
cross-test mock-queue drift (§ the `mockReset` note already in `blabber.test.ts`'s `beforeEach`).

- [ ] **Step 2: Run the full typecheck**

Run: `pnpm typecheck`
Expected: PASS on all three targets.

- [ ] **Step 3: Regenerate SQL one more time and eyeball the full diff**

Run: `pnpm generate:sql`
Expected: `gphone.sql` now includes `root_id` + its index on `gphone_blabber`, and the new
`gphone_blabber_tags` table, and nothing else changed.

No commit for this task unless `pnpm generate:sql` produced a diff not already committed in Tasks
2–3 (it shouldn't, since both tasks already regenerated and committed it) — if it does, that means
an earlier task's regeneration was stale; commit the corrected file with a note explaining why.

---

## Task 10: Client store — `viewBlab`, search stores, `trendingTags`, `loadTaggedBlabs`

**Files:**
- Modify: `web/src/apps/blabber/store.ts`
- Test: `web/src/apps/blabber/store.test.ts`

**Interfaces:**
- Removes: `loadBlab`, `loadThread` (both now folded into `viewBlab`).
- Produces (all exported from `useBlabber()`):
  - `viewBlab(id: number, opts?: { anchorId?: number }): Promise<{ root: Blab | null; replies:
    Blab[]; nextCursor: number | null }>`
  - `loadMoreReplies(rootId: number, cursor: number): Promise<{ rows: Blab[]; nextCursor: number |
    null }>` — a plain continuation call for "load older," separate from `viewBlab` because it
    never carries an anchor.
  - `accountResults: PagedStore<Account>`, `searchAccounts(q: string): Promise<void>`
  - `blabResults: PagedStore<Blab>`, `searchBlabs(q: string): Promise<void>`
  - `tagResults: Readable<{ tag: string; uses: number }[]>`, `searchTags(q: string): Promise<void>`
  - `trendingTags: Readable<{ tag: string; uses: number }[]>`, `loadTrendingTags(): Promise<void>`
  - `taggedBlabs: PagedStore<Blab>`, `loadTaggedBlabs(tag: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Add to `web/src/apps/blabber/store.test.ts`. First, update the import list at the top to drop
`loadThread`-related imports if any exist and add the new ones — check the current import block
(it lists `feed`, `myAccounts`, ... `sendDm`) and add:

```ts
import {
  // ...existing imports...
  viewBlab,
  loadMoreReplies,
  accountResults,
  searchAccounts,
  blabResults,
  searchBlabs,
  tagResults,
  searchTags,
  trendingTags,
  loadTrendingTags,
  taggedBlabs,
  loadTaggedBlabs
} from './store';
```

Then add a new `describe` block:

```ts
describe('viewing a Blab', () => {
  it('viewBlab calls the view action with the id', async () => {
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
      root: { id: 7, account_id: 1, body: 'root', created_at: '', updated_at: '' },
      replies: [],
      nextCursor: null
    } as any);

    const result = await viewBlab(7);

    expect(spy).toHaveBeenCalledWith(
      'svc',
      { service: 'blabber', action: 'view', data: { id: 7 } },
      undefined
    );
    expect(result.root?.id).toBe(7);
  });

  it('viewBlab passes anchorId through when given', async () => {
    const spy = vi
      .spyOn(fetchNuiModule, 'fetchNui')
      .mockResolvedValue({ root: null, replies: [], nextCursor: null } as any);

    await viewBlab(9, { anchorId: 9 });

    expect(spy).toHaveBeenCalledWith(
      'svc',
      { service: 'blabber', action: 'view', data: { id: 9, anchorId: 9 } },
      undefined
    );
  });
});

describe('search', () => {
  it('searchAccounts loads the accountResults store scoped to blabber', async () => {
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
      rows: [{ id: 1, app: 'blabber', handle: 'ada' }],
      nextCursor: null
    } as any);

    await searchAccounts('ad');

    expect(spy).toHaveBeenCalledWith(
      'svc',
      { service: 'accounts', action: 'search', data: { app: 'blabber', q: 'ad' } },
      undefined
    );
    expect(get(accountResults)).toHaveLength(1);
  });

  it('searchBlabs loads the blabResults store', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
      rows: [{ id: 8, account_id: 1, created_at: '', updated_at: '' }],
      nextCursor: null
    } as any);

    await searchBlabs('traffic');

    expect(get(blabResults)).toHaveLength(1);
  });

  it('searchTags populates tagResults', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
      rows: [{ tag: 'losangeles', uses: 5 }],
      nextCursor: null
    } as any);

    await searchTags('los');

    expect(get(tagResults)).toEqual([{ tag: 'losangeles', uses: 5 }]);
  });

  it('loadTrendingTags populates trendingTags', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue([
      { tag: 'losangeles', uses: 40 }
    ] as any);

    await loadTrendingTags();

    expect(get(trendingTags)).toEqual([{ tag: 'losangeles', uses: 40 }]);
  });

  it('loadTaggedBlabs loads the taggedBlabs store for one tag', async () => {
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
      rows: [{ id: 8, account_id: 1, created_at: '', updated_at: '' }],
      nextCursor: null
    } as any);

    await loadTaggedBlabs('losangeles');

    expect(spy).toHaveBeenCalledWith(
      'svc',
      { service: 'blabber', action: 'byTag', data: { tag: 'losangeles' } },
      undefined
    );
    expect(get(taggedBlabs)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit:web -- blabber/store`
Expected: FAIL — none of the new exports exist yet.

- [ ] **Step 3: Remove `loadBlab`/`loadThread`, add the new store surface**

In `web/src/apps/blabber/store.ts`, delete the existing `loadBlab` and `loadThread` exports
(currently just above the `unreadMentions` comment block), and replace with:

```ts
/**
 * One flattened screen for any Blab. The server resolves the root from whatever id is given —
 * a top-level post or any of its replies — so this is the single call every "open a Blab" site
 * makes, never a top-level-only read plus a separate replies fetch.
 */
export const viewBlab = async (
  id: number,
  opts: { anchorId?: number } = {}
): Promise<{ root: Blab | null; replies: Blab[]; nextCursor: number | null }> =>
  await blabberService().call('view', { id, ...opts }, { root: null, replies: [], nextCursor: null });

/** A plain continuation page — "load older" from an already-open flattened view, no anchor. */
export const loadMoreReplies = async (
  rootId: number,
  cursor: number
): Promise<{ rows: Blab[]; nextCursor: number | null }> =>
  await blabberService().call('view', { id: rootId, cursor }, { root: null, replies: [], nextCursor: null })
    .then((reply) => ({ rows: reply.replies, nextCursor: reply.nextCursor }));
```

Then, near the bottom of the file (after the DM section, before `useBlabber`), add:

```ts
/** The People segment: accounts whose handle or display name matches the query, this app only. */
export const accountResults = createPagedStore<Account>('search', { service: 'accounts' });
export const searchAccounts = (q: string): Promise<void> =>
  accountResults.load({ app: 'blabber', q });

/** The Blabs segment: body search, replies included. */
export const blabResults = createPagedStore<Blab>('search', { service: 'blabber' });
export const searchBlabs = (q: string): Promise<void> => blabResults.load({ q });

/** The Tags segment: matching tag names with a usage count, not a body search. */
export const tagResults = writable<{ tag: string; uses: number }[]>([]);
export const searchTags = async (q: string): Promise<void> => {
  const reply = await blabberService().call<{ rows: { tag: string; uses: number }[] }>(
    'searchTags',
    { q },
    { rows: [] }
  );
  tagResults.set(reply.rows);
};

/** A bounded snapshot loaded once when the Search tab opens, not paged. */
export const trendingTags = writable<{ tag: string; uses: number }[]>([]);
export const loadTrendingTags = async (): Promise<void> => {
  const rows = await blabberService().call<{ tag: string; uses: number }[]>(
    'trendingTags',
    {},
    []
  );
  trendingTags.set(rows);
};

/** Blabs carrying one exact tag — the shared landing spot for a Tags result, an inline tap, or a trending chip. */
export const taggedBlabs = createPagedStore<Blab>('byTag', { service: 'blabber' });
export const loadTaggedBlabs = (tag: string): Promise<void> => taggedBlabs.load({ tag });
```

Confirm `createPagedStore` and `writable`/`Readable` are already imported at the top of the file
(they are, for `feed`/`followingFeed`); if `Account` isn't already imported from `@shared/types`,
add it to the existing type import.

- [ ] **Step 4: Add every new export to `useBlabber()`'s return object**

In the `useBlabber()` function (bottom of the file), add:

```ts
    viewBlab: (id: number, opts?: { anchorId?: number }) => viewBlab(id, opts),
    loadMoreReplies: (rootId: number, cursor: number) => loadMoreReplies(rootId, cursor),
    accountResults,
    searchAccounts: (q: string) => searchAccounts(q),
    blabResults,
    searchBlabs: (q: string) => searchBlabs(q),
    tagResults,
    searchTags: (q: string) => searchTags(q),
    trendingTags,
    loadTrendingTags: () => loadTrendingTags(),
    taggedBlabs,
    loadTaggedBlabs: (tag: string) => loadTaggedBlabs(tag),
```

Remove `loadThread: (blabId: number) => loadThread(blabId),` from this same return object — the
symbol it referenced no longer exists.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:unit:web -- blabber/store`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck:web`
Expected: FAIL at this point — `Thread.svelte` (Task 11 deletes it) still imports `loadThread`.
This is expected and resolved by Task 11; do not attempt to fix it here.

- [ ] **Step 7: Commit**

```bash
git add web/src/apps/blabber/store.ts web/src/apps/blabber/store.test.ts
git commit -m "feat(blabber): store support for viewBlab and the four search kinds"
```

---

## Task 11: `BlabDetail.svelte` — replaces `Thread.svelte`

**Files:**
- Create: `web/src/apps/blabber/components/BlabDetail.svelte`
- Delete: `web/src/apps/blabber/components/Thread.svelte`
- Test: covered by Task 15's e2e cases (this component has no store logic of its own worth a unit
  test — its behavior is entirely "call `viewBlab`, render what comes back," which the e2e suite
  exercises end to end; matches how `Thread.svelte` itself had no dedicated unit test file).

**Interfaces:**
- Consumes: `viewBlab`, `loadMoreReplies` (Task 10), `usePagedList` (existing SDK hook).
- Produces: a component with props `{ blabId: number; anchorId?: number; handle?: string; busy?:
  boolean; onhandle?, ontag?, onmouth?, onlike? }`. No `onopen` prop — there is nowhere further to
  navigate to.

- [ ] **Step 1: Delete `Thread.svelte`**

```bash
rm web/src/apps/blabber/components/Thread.svelte
```

- [ ] **Step 2: Write `BlabDetail.svelte`**

```svelte
<script lang="ts">
  import { EmptyState, Skeleton, usePagedList } from '@gphone/sdk';
  import { useBlabber } from '../store';
  import type { Blab } from '@shared/types';
  import BlabRow from './BlabRow.svelte';
  import Composer from './Composer.svelte';

  /**
   * One Blab, flattened: the root, then every reply under it at any depth, in one screen.
   *
   * Replaces `Thread.svelte`, which let a tap on a reply push a new, identically-shaped screen
   * one level deeper — unbounded, and with no landing spot for a search result that is itself a
   * reply. `root_id` (server/services/Blabber.ts) is what makes "every reply at any depth" a
   * single query instead of a walk: see the design spec for why.
   *
   * A reply row here has no `onopen` — there is nowhere further to go. Tapping "Reply" on any
   * row, root included, retargets the one composer at the bottom rather than opening anything.
   */
  let {
    blabId,
    anchorId,
    handle,
    busy = false,
    onhandle,
    ontag,
    onmouth,
    onlike
  }: {
    blabId: number;
    anchorId?: number;
    handle?: string;
    busy?: boolean;
    onhandle?: (handle: string) => void;
    ontag?: (tag: string) => void;
    onmouth?: (blab: Blab) => void;
    onlike?: (blab: Blab) => void;
  } = $props();

  const { viewBlab, loadMoreReplies, engagement, loadEngagement, postBlab } = useBlabber();

  let root = $state<Blab | null>(null);
  let replies = $state<Blab[]>([]);
  let cursor = $state<number | null>(null);
  let loading = $state(true);
  let missing = $state(false);
  /** Who the pinned composer targets — the root by default, or whichever row's Reply was tapped. */
  let replyTarget = $state<Blab | null>(null);

  const refresh = async () => {
    loading = true;
    try {
      const reply = await viewBlab(blabId, anchorId ? { anchorId } : {});
      root = reply.root;
      missing = reply.root === null;
      replies = reply.replies;
      cursor = reply.nextCursor;
      replyTarget = reply.root;
      if (reply.root) {
        await loadEngagement([reply.root.id, ...reply.replies.map((r) => r.id)]);
      }
    } finally {
      loading = false;
    }
  };

  $effect(() => {
    void blabId;
    void anchorId;
    root = null;
    replies = [];
    void refresh();
  });

  const page = usePagedList<Blab>({
    items: () => replies,
    olderAt: 'end',
    pageSize: 30,
    loadOlder: async () => {
      if (cursor === null || root === null) return false;
      const more = await loadMoreReplies(root.id, cursor);
      cursor = more.nextCursor;
      if (more.rows.length === 0) return false;
      replies = [...replies, ...more.rows];
      await loadEngagement(more.rows.map((r) => r.id));
      return true;
    },
    hasMore: () => cursor !== null
  });

  const submitReply = async (body: string) => {
    if (!replyTarget) return;
    await postBlab(body, replyTarget.id);
    await refresh();
  };
</script>

<div class="flex h-full flex-col">
  {#if missing}
    <EmptyState
      title="Blab unavailable"
      description="This post has been deleted or is no longer visible."
    />
  {:else}
    <div class="border-outline-variant border-b">
      {#if root}
        <BlabRow
          blab={root}
          stats={$engagement[root.id]}
          {onhandle}
          onmouth={() => root && onmouth?.(root)}
          onlike={() => root && onlike?.(root)}
          onreply={() => (replyTarget = root)}
        />
      {:else}
        <div class="p-4"><Skeleton count={1} height="h-16" /></div>
      {/if}
    </div>

    <Composer
      {handle}
      placeholder={replyTarget && root && replyTarget.id !== root.id
        ? `Reply to @${replyTarget.handle ?? ''}`
        : 'Post your reply'}
      {busy}
      onsubmit={submitReply}
    />

    <div class="flex-1 overflow-y-auto" onscroll={page.onScroll}>
      {#if loading && replies.length === 0}
        <div class="p-4"><Skeleton count={2} height="h-16" /></div>
      {:else if replies.length === 0}
        <EmptyState title="No replies yet" description="Say something back." />
      {:else}
        {#each page.visible as reply (reply.id)}
          <BlabRow
            blab={reply}
            stats={$engagement[reply.id]}
            {onhandle}
            onreply={() => (replyTarget = reply)}
            onmouth={() => onmouth?.(reply)}
            onlike={() => onlike?.(reply)}
          />
        {/each}
        {#if page.loading}
          <div class="p-4"><Skeleton count={2} height="h-16" /></div>
        {/if}
      {/if}
    </div>
  {/if}
</div>
```

Note: `ontag` is accepted as a prop but not yet threaded to `BlabBody` here — that wiring is
Task 13, once `BlabBody` actually accepts the callback. Accepting-but-not-yet-using it here would
leave an unused variable and fail lint; **do not add the `ontag` prop to this file's destructuring
until Task 13**. Cut it from Step 2 above for now — add it back in Task 13 alongside the
`BlabRow`/`BlabBody` wiring, in the same commit as that task. (This note exists because Task 13
depends on this file existing; sequencing them the other way around would mean either an unused
prop here or a forward reference to a component that isn't ready yet.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck:web`
Expected: still FAILS — `index.svelte` (Task 12) still imports the deleted `Thread.svelte` and
still uses `threads`/`onopen` in a way this new component doesn't support. Expected at this point
in the sequence; resolved by Task 12.

- [ ] **Step 4: Commit**

```bash
git add web/src/apps/blabber/components/BlabDetail.svelte
git rm web/src/apps/blabber/components/Thread.svelte
git commit -m "feat(blabber): BlabDetail — one flattened screen, replacing Thread's nested stack"
```

---

## Task 12: `index.svelte` — collapse the thread stack to `activeBlabId`

**Files:**
- Modify: `web/src/apps/blabber/index.svelte`

**Interfaces:**
- Consumes: `BlabDetail` (Task 11, minus `ontag` for now — added in Task 13).
- Removes: `threads: Blab[]` state, the two thread-related `useAppLevels` rungs (collapsed to one),
  `Thread` import.

- [ ] **Step 1: Replace the `threads` stack with `activeBlabId`**

Replace (currently lines 129–136):

```ts
  /**
   * The thread stack, not a single value.
   *
   * Opening a reply's own thread pushes onto it, so Back walks out one level at a time instead
   * of jumping to the feed. Replies nest through one column, so the depth is whatever the
   * conversation is.
   */
  let threads = $state<Blab[]>([]);
```

with:

```ts
  /**
   * Which Blab is open, or null. One value rather than a stack: `BlabDetail` flattens the whole
   * reply tree into one screen (Task 11), so there is no second level to push onto — opening a
   * reply from inside an already-open Blab is not a thing that happens any more (§ design spec,
   * "Navigation: one screen, not a stack").
   */
  let activeBlabId = $state<number | null>(null);
  /** Set only for a reply reached via search — scrolls that row into view once it renders. */
  let activeAnchorId = $state<number | undefined>(undefined);
```

- [ ] **Step 2: Replace `openThread`**

Replace (currently):

```ts
  const openThread = (blab: Blab) => {
    threads = view === 'thread' ? [...threads, blab] : [blab];
    view = 'thread';
  };
```

with:

```ts
  const openBlab = (id: number, anchorId?: number) => {
    activeBlabId = id;
    activeAnchorId = anchorId;
    view = 'thread';
  };
```

Every call site that referenced `openThread` now calls `openBlab(blab.id)` instead of
`openThread(blab)` — `BlabDetail` takes an id, not a full row, since it always re-fetches (Task 11
Step 2). Update:

- The deep-link handler: `openThread({ id: blabId } as Blab)` → `openBlab(blabId)`.
- `NotificationsTab`'s `onopenblab={(blabId) => openThread({ id: blabId } as Blab)}` →
  `onopenblab={openBlab}`.
- Both `BlabRow` call sites (`onopen={openThread}` in the following-tab and feed-tab `{#each}`
  blocks) → `onopen={(blab) => openBlab(blab.id)}`.

- [ ] **Step 3: Simplify the `useAppLevels` rungs**

Replace the two thread rungs (currently):

```ts
      {
        open: () => view === 'thread' && threads.length > 1,
        close: () => threads.pop(),
        title: () => 'Thread'
      },
      {
        open: () => view === 'thread',
        close: () => {
          threads = [];
          view = 'feed';
        },
        title: () => 'Thread'
      },
```

with one:

```ts
      {
        open: () => view === 'thread',
        close: () => {
          activeBlabId = null;
          activeAnchorId = undefined;
          view = 'feed';
        },
        title: () => 'Blab'
      },
```

- [ ] **Step 4: Swap the render**

Replace (currently):

```svelte
  {:else if view === 'thread' && threads.length > 0}
    <Thread
      root={threads[threads.length - 1]}
      handle={$activeAccount?.handle}
      busy={$busy}
      onhandle={openProfile}
      onopen={openThread}
      onreply={replyTo}
      onmouth={mouth}
      onlike={like}
    />
```

with:

```svelte
  {:else if view === 'thread' && activeBlabId !== null}
    <BlabDetail
      blabId={activeBlabId}
      anchorId={activeAnchorId}
      handle={$activeAccount?.handle}
      busy={$busy}
      onhandle={openProfile}
      onmouth={mouth}
      onlike={like}
    />
```

- [ ] **Step 5: Update imports**

Replace `import Thread from './components/Thread.svelte';` with
`import BlabDetail from './components/BlabDetail.svelte';`.

`replyTo` (the function currently passed as `Thread`'s `onreply`) is now unused at this call site —
`BlabDetail` posts replies itself via `postBlab` internally (Task 11 Step 2). Check whether
`replyTo` is used anywhere else in `index.svelte` before removing it; if it is now fully unused,
delete its definition too (Task 9's `pnpm deadcode` gate, run in the final verification task, will
also catch this if missed here).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck:web`
Expected: PASS now (Task 10's dangling `Thread.svelte` reference and Task 11's dangling
`index.svelte` reference are both resolved by this task).

- [ ] **Step 7: Run the existing e2e suite for this app**

Run: `pnpm test:e2e blabber`
Expected: some existing cases will fail here — specifically anything that opened a nested thread
(reply-into-a-reply) expecting a second pushed screen, since that behavior no longer exists. Do
not fix those tests in this task; Task 15 rewrites the e2e suite to match the new flattened
behavior. Note which cases fail so Task 15's rewrite covers them.

- [ ] **Step 8: Commit**

```bash
git add web/src/apps/blabber/index.svelte
git commit -m "feat(blabber): collapse thread navigation to a single activeBlabId"
```

---

## Task 13: Tag taps — `BlabBody`, `BlabRow`, `BlabDetail`, `Messages`, `TaggedFeed`

**Files:**
- Modify: `web/src/apps/blabber/components/BlabBody.svelte`
- Modify: `web/src/apps/blabber/components/BlabRow.svelte`
- Modify: `web/src/apps/blabber/components/BlabDetail.svelte` (add the `ontag` prop deferred from
  Task 11)
- Modify: `web/src/apps/blabber/components/Messages.svelte`
- Create: `web/src/apps/blabber/components/TaggedFeed.svelte`
- Modify: `web/src/apps/blabber/index.svelte` (wire `ontag` through, add the `view === 'tag'`
  screen)

**Interfaces:**
- Consumes: `taggedBlabs`, `loadTaggedBlabs` (Task 10).
- Produces: `ontag(tag: string): void` threaded the same path `onhandle` already takes.

- [ ] **Step 1: `BlabBody.svelte` — tag becomes a button**

Change:

```svelte
  let { body, onhandle }: { body: string; onhandle?: (handle: string) => void } = $props();
```

to:

```svelte
  let {
    body,
    onhandle,
    ontag
  }: {
    body: string;
    onhandle?: (handle: string) => void;
    ontag?: (tag: string) => void;
  } = $props();
```

Change:

```svelte
    {:else if token.kind === 'tag'}
      <span class="font-semibold text-sky-300">#{token.value}</span>
```

to:

```svelte
    {:else if token.kind === 'tag'}
      <button
        type="button"
        class="font-semibold text-sky-300 hover:underline"
        onclick={() => ontag?.(token.value)}>#{token.value}</button
      >
```

- [ ] **Step 2: `BlabRow.svelte` — thread `ontag` through**

Add `ontag` to the props destructuring (alongside `onhandle`) and pass it to both `BlabBody` call
sites (the row's own body and the mouthed-quote body):

```ts
  let {
    blab,
    editable = false,
    stats,
    onhandle,
    ontag,
    onedit,
    ondelete,
    onreply,
    onmouth,
    onlike,
    onopen
  }: {
    blab: Blab;
    editable?: boolean;
    stats?: BlabEngagement;
    onhandle?: (handle: string) => void;
    ontag?: (tag: string) => void;
    onedit?: (blab: Blab) => void;
    ondelete?: (blab: Blab) => void;
    onreply?: (blab: Blab) => void;
    onmouth?: (blab: Blab) => void;
    onlike?: (blab: Blab) => void;
    onopen?: (blab: Blab) => void;
  } = $props();
```

```svelte
        <BlabBody body={blab.body ?? ''} {onhandle} {ontag} />
```

```svelte
        <BlabBody body={blab.mouthed.body ?? ''} {onhandle} {ontag} />
```

- [ ] **Step 3: `BlabDetail.svelte` — add `ontag` prop and thread it**

Add `ontag` to the props destructuring (it was deliberately left out of Task 11's draft — see the
note at the end of that task):

```ts
    onhandle,
    ontag,
    onmouth,
```

and to the type:

```ts
    onhandle?: (handle: string) => void;
    ontag?: (tag: string) => void;
    onmouth?: (blab: Blab) => void;
```

Pass `{ontag}` to both `BlabRow` call sites (root and each reply row).

- [ ] **Step 4: `Messages.svelte` — same threading, for DM bodies**

Add `ontag` to its props and pass it to its `BlabBody` call site, mirroring how `onhandle` already
flows through this file.

- [ ] **Step 5: `TaggedFeed.svelte` — the screen a tag tap lands on**

```svelte
<script lang="ts">
  import { EmptyState, Skeleton, usePagedList } from '@gphone/sdk';
  import { useBlabber } from '../store';
  import type { Blab } from '@shared/types';
  import BlabRow from './BlabRow.svelte';

  /**
   * Blabs carrying one tag — reached from an inline `#tag` tap, the Tags search segment, or a
   * trending chip. One screen, three ways in, per the design spec.
   */
  let {
    tag,
    onhandle,
    ontag,
    onopen,
    onmouth,
    onlike
  }: {
    tag: string;
    onhandle?: (handle: string) => void;
    ontag?: (tag: string) => void;
    onopen?: (blab: Blab) => void;
    onmouth?: (blab: Blab) => void;
    onlike?: (blab: Blab) => void;
  } = $props();

  const { taggedBlabs, loadTaggedBlabs, engagement, loadEngagement } = useBlabber();
  const loaded = taggedBlabs.loaded;

  $effect(() => {
    void tag;
    void loadTaggedBlabs(tag);
  });

  const page = usePagedList<Blab>({
    items: () => $taggedBlabs,
    olderAt: 'end',
    pageSize: 30,
    loadOlder: () => taggedBlabs.loadMore(),
    hasMore: () => hasMoreSnapshot
  });

  let hasMoreSnapshot = $state(false);
  taggedBlabs.hasMore.subscribe((value) => (hasMoreSnapshot = value));

  $effect(() => {
    const ids = page.visible.map((blab) => blab.id);
    if (ids.length > 0) void loadEngagement(ids);
  });
</script>

<div class="flex-1 overflow-y-auto pb-20" onscroll={page.onScroll}>
  {#if !$loaded}
    <div class="p-4"><Skeleton count={4} height="h-16" /></div>
  {:else if $taggedBlabs.length === 0}
    <EmptyState title="Nothing tagged yet" description="No Blabs carry #{tag} yet." />
  {:else}
    {#each page.visible as blab (blab.id)}
      <BlabRow
        {blab}
        stats={$engagement[blab.id]}
        {onhandle}
        {ontag}
        onreply={() => onopen?.(blab)}
        onmouth={() => onmouth?.(blab)}
        onlike={() => onlike?.(blab)}
        {onopen}
      />
    {/each}
    {#if page.loading}
      <div class="p-4"><Skeleton count={2} height="h-16" /></div>
    {/if}
  {/if}
</div>
```

- [ ] **Step 6: Wire it into `index.svelte`**

Add `'tag'` to the `view` union (currently `'feed' | 'profile' | 'thread' | 'dms' | 'follows'`):

```ts
  let view = $state<'feed' | 'profile' | 'thread' | 'dms' | 'follows' | 'tag'>('feed');
```

Add a tag-open helper near `openBlab`/`openProfile`:

```ts
  let activeTag = $state<string | null>(null);

  const openTag = (tag: string) => {
    activeTag = tag;
    view = 'tag';
  };
```

Add a `useAppLevels` rung for it — same shape as the `profile` rung, placed alongside it:

```ts
      { open: () => view === 'tag', close: () => (view = 'feed'), title: () => `#${activeTag}` },
```

Import and render `TaggedFeed` in the main `{#if view === ...}` chain, alongside the `follows`/
`profile` branches:

```svelte
  {:else if view === 'tag' && activeTag}
    <TaggedFeed tag={activeTag} onhandle={openProfile} ontag={openTag} onopen={(b) => openBlab(b.id)} onmouth={mouth} onlike={like} />
```

Finally, pass `ontag={openTag}` to every existing `BlabRow`/`BlabDetail`/`Messages` call site in
`index.svelte` (the feed `{#each}`, the following-tab `{#each}`, the `BlabDetail` render from
Task 12, and `Messages`'s render in the `dms` branch) — this is the actual "tag taps work
everywhere" wiring; Steps 1–5 above only built the plumbing.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck:web`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src/apps/blabber/components/BlabBody.svelte \
        web/src/apps/blabber/components/BlabRow.svelte \
        web/src/apps/blabber/components/BlabDetail.svelte \
        web/src/apps/blabber/components/Messages.svelte \
        web/src/apps/blabber/components/TaggedFeed.svelte \
        web/src/apps/blabber/index.svelte
git commit -m "feat(blabber): make hashtags tappable, everywhere a Blab body renders"
```

---

## Task 14: `SearchBar.svelte` — fix the `use:focus` stub

**Files:**
- Modify: `web/src/sdk/ui/SearchBar.svelte`

- [ ] **Step 1: Fix it**

Replace:

```ts
  const focus = (node: HTMLInputElement) => {
    // Optional autofocus could be added here if needed
  };
```

with:

```ts
  const focus = (node: HTMLInputElement) => {
    node.focus();
  };
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck:web` — expect PASS (no signature change).

- [ ] **Step 3: Commit**

```bash
git add web/src/sdk/ui/SearchBar.svelte
git commit -m "fix(sdk): SearchBar's use:focus actually focuses the field"
```

---

## Task 15: `Search.svelte` — the fourth tab

**Files:**
- Create: `web/src/apps/blabber/components/Search.svelte`
- Modify: `web/src/apps/blabber/index.svelte`

**Interfaces:**
- Consumes: `accountResults`/`searchAccounts`, `blabResults`/`searchBlabs`, `tagResults`/
  `searchTags`, `trendingTags`/`loadTrendingTags` (Task 10); `SearchBar`, `SegmentedControl`
  (existing SDK exports).

- [ ] **Step 1: Write `Search.svelte`**

```svelte
<script lang="ts">
  import { SearchBar, SegmentedControl, EmptyState, Skeleton } from '@gphone/sdk';
  import { useBlabber } from '../store';
  import BlabRow from './BlabRow.svelte';

  let {
    onhandle,
    ontag,
    onopen
  }: {
    onhandle?: (handle: string) => void;
    ontag?: (tag: string) => void;
    onopen?: (id: number) => void;
  } = $props();

  const {
    accountResults,
    searchAccounts,
    blabResults,
    searchBlabs,
    tagResults,
    searchTags,
    trendingTags,
    loadTrendingTags,
    engagement,
    loadEngagement
  } = useBlabber();

  let query = $state('');
  let segment = $state<'people' | 'blabs' | 'tags'>('people');

  $effect(() => {
    void loadTrendingTags();
  });

  /**
   * Below 2 characters, nothing fires. A single letter against a `LIKE '%x%'` body scan is close
   * to a full table scan on every keystroke, and this cuts the match rate sharply for cheap.
   */
  $effect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    if (segment === 'people') void searchAccounts(q);
    else if (segment === 'blabs') void searchBlabs(q);
    else void searchTags(q);
  });

  $effect(() => {
    if (segment !== 'blabs') return;
    const ids = $blabResults.map((b) => b.id);
    if (ids.length > 0) void loadEngagement(ids);
  });

  const showingTrending = $derived(query.trim().length < 2);
</script>

<div class="flex h-full flex-col">
  <div class="border-outline-variant space-y-2 border-b p-3">
    <SearchBar bind:value={query} placeholder="Search Blabber" />
    <SegmentedControl
      value={segment}
      onchange={(next) => (segment = next as typeof segment)}
      options={[
        { value: 'people', label: 'People' },
        { value: 'blabs', label: 'Blabs' },
        { value: 'tags', label: 'Tags' }
      ]}
    />
  </div>

  <div class="flex-1 overflow-y-auto pb-20">
    {#if showingTrending}
      {#if $trendingTags.length === 0}
        <EmptyState title="Nothing trending yet" description="Check back once people start posting." />
      {:else}
        <div class="flex flex-wrap gap-2 p-3">
          {#each $trendingTags as t (t.tag)}
            <button
              type="button"
              class="bg-surface-container text-on-surface rounded-full px-3 py-1.5 text-xs font-medium"
              onclick={() => ontag?.(t.tag)}
            >
              #{t.tag} · {t.uses}
            </button>
          {/each}
        </div>
      {/if}
    {:else if segment === 'people'}
      {#if !$accountResults.loaded}
        <div class="p-4"><Skeleton count={4} height="h-14" /></div>
      {:else if $accountResults.length === 0}
        <EmptyState title="No people found" description="Try a different handle or name." />
      {:else}
        {#each $accountResults as account (account.id)}
          <button
            type="button"
            class="hover:bg-surface-container flex w-full items-center gap-3 px-4 py-3 text-left"
            onclick={() => onhandle?.(account.handle)}
          >
            <span class="text-on-surface text-sm font-semibold">
              {account.display_name || account.handle}
            </span>
            <span class="text-on-surface-variant text-xs">@{account.handle}</span>
          </button>
        {/each}
      {/if}
    {:else if segment === 'blabs'}
      {#if !$blabResults.loaded}
        <div class="p-4"><Skeleton count={4} height="h-16" /></div>
      {:else if $blabResults.length === 0}
        <EmptyState title="No Blabs found" description="Try different words." />
      {:else}
        {#each $blabResults as blab (blab.id)}
          <BlabRow
            {blab}
            stats={$engagement[blab.id]}
            {onhandle}
            {ontag}
            onopen={() => onopen?.(blab.id)}
          />
        {/each}
      {/if}
    {:else if $tagResults.length === 0}
      <EmptyState title="No tags found" description="Try a shorter search." />
    {:else}
      {#each $tagResults as t (t.tag)}
        <button
          type="button"
          class="hover:bg-surface-container flex w-full items-center justify-between px-4 py-3 text-left"
          onclick={() => ontag?.(t.tag)}
        >
          <span class="text-on-surface text-sm font-semibold">#{t.tag}</span>
          <span class="text-on-surface-variant text-xs">{t.uses} Blabs</span>
        </button>
      {/each}
    {/if}
  </div>
</div>
```

Note: `accountResults`/`blabResults` are `PagedStore`s (Task 10), which expose `.loaded` as a
nested `Readable`, not a plain boolean on the store's own value — `$accountResults.loaded` above is
wrong as written; it must be a separate subscription, matching how `index.svelte` already handles
`feed.loaded` (`const feedLoaded = feed.loaded;` then `$feedLoaded`). Fix in Step 1's script block
before treating this task as done:

```ts
  const accountsLoaded = accountResults.loaded;
  const blabsLoaded = blabResults.loaded;
```

and use `$accountsLoaded` / `$blabsLoaded` in the template instead of `$accountResults.loaded` /
`$blabResults.loaded`.

- [ ] **Step 2: Wire the fourth tab into `index.svelte`**

Extend the `tab` union:

```ts
  let tab = $state<'feed' | 'following' | 'notifications' | 'search'>('feed');
```

Add `'search'` to `selectTab`'s guard:

```ts
    if (next !== 'feed' && next !== 'following' && next !== 'notifications' && next !== 'search')
      return;
```

Add a fourth `TabBar` option (a `SearchIcon` needs to exist in the SDK icon set — check
`web/src/sdk/icons.ts`, generated from `scripts/generate-barrels.js`; if no search icon exists yet,
add an SVG icon component under `web/src/sdk/ui/icons/` following the shape of the existing
`BellIcon`/`UsersIcon` files, and it will be picked up by the barrel generator on the next
`pnpm verify`/`pnpm generate:sql`-adjacent build step — do not hand-edit `icons.ts`):

```svelte
        { id: 'search', label: 'Search', icon: SearchIcon }
```

Import `Search` and render it in the main branch chain:

```svelte
  {:else if tab === 'search'}
    <Search onhandle={openProfile} ontag={openTag} onopen={(id) => openBlab(id)} />
```

Update the back-rung title logic (currently a two-way ternary for `notifications`/`following`) to a
small lookup covering all three non-default tabs:

```ts
        title: () =>
          tab === 'notifications' ? 'Notifications' : tab === 'search' ? 'Search' : 'Following'
```

- [ ] **Step 3: Write the client store test for the 2-character gate**

This is a component behavior, not a store one, so it belongs in Task 16's e2e suite rather than
here — no additional store test needed for this step; `searchAccounts`/`searchBlabs`/`searchTags`
themselves have no minimum-length logic (that lives in `Search.svelte`'s `$effect`), matching how
the store layer stays a thin wrapper and UI-level gating stays in the component, consistent with
where `Search.svelte`'s own trending-vs-results branching already lives.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck:web` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/apps/blabber/components/Search.svelte web/src/apps/blabber/index.svelte
git commit -m "feat(blabber): Search tab — people, Blabs, tags, and trending"
```

---

## Task 16: Mock registry — every new/changed action

**Files:**
- Modify: `web/src/nui/mocks/registry.ts`

**Interfaces:** none new — this task only makes `pnpm dev` and Playwright agree with the server
built in Tasks 2–8.

- [ ] **Step 1: Replace the `'blabber:blab'` mock with `'blabber:view'`**

Find (added last session):

```ts
  'blabber:blab': ({ id }: { id: number }) =>
    mockBlabs.find((b) => b.id === id && b.status === 'active') ?? null,
```

Replace with:

```ts
  'blabber:view': ({
    id,
    cursor,
    limit = 30,
    anchorId
  }: {
    id: number;
    cursor?: number;
    limit?: number;
    anchorId?: number;
  }) => {
    const requested = mockBlabs.find((b) => b.id === id && b.status === 'active');
    if (!requested) return { root: null, replies: [], nextCursor: null };

    const rootId = requested.root_id ?? requested.id;
    const root = mockBlabs.find((b) => b.id === rootId && b.status === 'active') ?? null;
    if (!root) return { root: null, replies: [], nextCursor: null };

    const subtree = mockBlabs
      .filter((b) => b.status === 'active' && b.id !== rootId && (b.root_id ?? b.id) === rootId)
      .sort((a, b) => b.id - a.id);

    let windowed = subtree;
    if (cursor === undefined && anchorId !== undefined) {
      const newer = subtree.filter((b) => b.id > anchorId).slice().reverse();
      const older = subtree.filter((b) => b.id <= anchorId);
      windowed = [...newer.slice().reverse(), ...older];
    } else if (cursor !== undefined) {
      windowed = subtree.filter((b) => b.id < cursor);
    }

    const page = windowed.slice(0, limit);
    const hasMore = windowed.length > page.length;
    return { root, replies: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
```

- [ ] **Step 2: Add `root_id` to `'blabber:create'`'s mock and to the fixtures**

In the `mockBlabs` fixture array (the `traffic on the interstate` / `first` / `congratulations on
being first` / `thank you` entries), give each row an explicit `root_id`: `null` for the two
top-level posts (ids 3 and 2), and the appropriate top-level id for the replies (id 4's `root_id:
1`, id 5's `root_id: 1` — both descend from post id 1, "first").

In `'blabber:create'`'s handler, compute `root_id` the same way the server does:

```ts
    const replyParent =
      reply_to != null ? mockBlabs.find((b) => b.id === reply_to) : undefined;
    const rootId = replyParent ? (replyParent.root_id ?? replyParent.id) : null;
```

and add `root_id: rootId` to the `created` object.

- [ ] **Step 3: Add mocks for the four search/tag actions**

```ts
  'accounts:search': ({ app, q, cursor, limit = 30 }: { app: string; q: string; cursor?: number; limit?: number }) => {
    const needle = q.toLowerCase();
    const visible = mockAccounts
      .filter(
        (a) =>
          a.app === app &&
          a.status === 'active' &&
          (a.handle.toLowerCase().includes(needle) ||
            (a.display_name ?? '').toLowerCase().includes(needle)) &&
          (cursor === undefined || a.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  'blabber:search': ({ q, cursor, limit = 30 }: { q: string; cursor?: number; limit?: number }) => {
    const needle = q.toLowerCase();
    const visible = mockBlabs
      .filter(
        (b) =>
          b.status === 'active' &&
          (b.body ?? '').toLowerCase().includes(needle) &&
          (cursor === undefined || b.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  'blabber:searchTags': ({ q }: { q: string }) => {
    const counts = new Map<string, number>();
    for (const [, tags] of mockBlabTags) {
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const rows = [...counts.entries()]
      .filter(([tag]) => tag.startsWith(q.toLowerCase()))
      .map(([tag, uses]) => ({ tag, uses }))
      .sort((a, b) => b.uses - a.uses);
    return { rows, nextCursor: null };
  },
  'blabber:byTag': ({ tag, cursor, limit = 30 }: { tag: string; cursor?: number; limit?: number }) => {
    const ids = new Set(
      [...mockBlabTags.entries()].filter(([, tags]) => tags.includes(tag)).map(([id]) => id)
    );
    const visible = mockBlabs
      .filter((b) => ids.has(b.id) && b.status === 'active' && (cursor === undefined || b.id < cursor))
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  'blabber:trendingTags': () => {
    const counts = new Map<string, number>();
    for (const [, tags] of mockBlabTags) {
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, uses]) => ({ tag, uses }))
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 10);
  },
```

This introduces a new fixture map, `mockBlabTags: Map<number, string[]>` — add it near `mockBlabs`,
seeded from each fixture's body via the real `taggedTopics` (import it from `@shared/richText`, the
same module the server uses, so the mock cannot silently drift from what the real tokenizer would
extract):

```ts
import { taggedTopics } from '@shared/richText';

const mockBlabTags = new Map<number, string[]>(
  mockBlabs.map((b) => [b.id, taggedTopics(b.body ?? '')])
);
```

Also extend `'blabber:create'`'s handler to add the newly-created Blab's tags to this map, mirroring
the server's create-time indexing:

```ts
    mockBlabTags.set(created.id, taggedTopics(created.body ?? ''));
```

- [ ] **Step 2: Typecheck and a manual `pnpm dev` smoke check**

Run: `pnpm typecheck:web` — expect PASS.

Run: `pnpm dev` (long-running — ask before running per this repo's convention; if already running,
reuse it) and manually open Blabber in the browser: confirm the feed still renders, tap a Blab and
confirm the flattened view renders with its replies, tap a `#` tag in a body and confirm it opens a
tag screen, open the Search tab and type a 2+ character query in each segment.

- [ ] **Step 3: Commit**

```bash
git add web/src/nui/mocks/registry.ts
git commit -m "feat(blabber): mock every new/changed action — view, search, tags"
```

---

## Task 17: E2e — flattened view, tags, search

**Files:**
- Modify: `web/e2e/apps/blabber.spec.ts`

- [ ] **Step 1: Fix the pre-existing "opens a thread and replies to a reply" case**

Find the existing test (around the line the deep-link/notification tests sit near — search for
`'opens a thread and replies to a reply'`). It currently asserts a nested-thread push. Rewrite it
to assert the new flattened behavior:

```ts
test('opens a Blab and replies to a reply, both landing in the same flattened view', async ({
  page
}) => {
  await page
    .locator('article', { hasText: 'first' })
    .getByRole('button', { name: 'View thread' })
    .click();

  // The reply is already flattened into this one screen — no further navigation.
  await expect(page.locator('text=congratulations on being first')).toBeVisible();

  // Tapping Reply on that flattened reply retargets the one composer, rather than opening
  // anything new.
  await page
    .locator('article', { hasText: 'congratulations on being first' })
    .getByRole('button', { name: 'Reply' })
    .click();
  await expect(page.locator('text=Reply to @nightowl')).toBeVisible();

  await page.locator('textarea').fill('replying to the reply');
  await page.getByRole('button', { name: 'Post', exact: true }).click();

  await expect(page.locator('text=replying to the reply')).toBeVisible();
  // Still one screen — no second Thread/BlabDetail level was pushed.
  await expect(page.locator('h1', { hasText: 'Blab' })).toBeVisible();
});
```

- [ ] **Step 2: Add the flattened-view-from-search regression test**

```ts
test.describe('Search tab', () => {
  const openSearch = (page: import('@playwright/test').Page) =>
    page.getByRole('button', { name: 'Search', exact: true }).click();

  test('a query under 2 characters fires no request', async ({ page }) => {
    await openSearch(page);
    await page.locator('input[placeholder="Search Blabber"]').fill('a');
    // Trending, not results — the empty/results branch never activates below 2 characters.
    await expect(page.locator('text=Nothing trending yet')).toHaveCount(0);
    await expect(page.locator('text=No people found')).toHaveCount(0);
  });

  test('trending chips render before typing and disappear once a query is entered', async ({
    page
  }) => {
    await openSearch(page);
    await expect(page.locator('button', { hasText: '#losangeles' })).toBeVisible();

    await page.locator('input[placeholder="Search Blabber"]').fill('ad');
    await expect(page.locator('button', { hasText: '#losangeles' })).toHaveCount(0);
  });

  test('finding a Blab by body and opening it lands on the flattened view', async ({ page }) => {
    await openSearch(page);
    await page.getByRole('button', { name: 'Blabs', exact: true }).click();
    await page.locator('input[placeholder="Search Blabber"]').fill('traffic');

    await page.locator('article', { hasText: 'traffic on the interstate' }).click();

    await expect(page.getByRole('button', { name: "Ada's profile" })).toBeVisible();
  });

  test('tapping a tag inline, and the same tag from the Tags segment, both land on the same tag screen', async ({
    page
  }) => {
    await page.locator('button', { hasText: '#losangeles' }).first().click();
    await expect(page.locator('h1', { hasText: '#losangeles' })).toBeVisible();
    await page.keyboard.press('Backspace');

    await openSearch(page);
    await page.getByRole('button', { name: 'Tags', exact: true }).click();
    await page.locator('input[placeholder="Search Blabber"]').fill('los');
    await page.locator('button', { hasText: '#losangeles' }).click();

    await expect(page.locator('h1', { hasText: '#losangeles' })).toBeVisible();
  });
});
```

**Note:** these tests assume `#losangeles` exists as a tag on a fixture Blab and that clicking it
inline is reachable from wherever the test starts (the feed, per the existing fixture — post id 3,
"traffic on the interstate is unreal today #losangeles", already carries this tag per the mock
registry excerpt read during planning). Adjust the exact locator/starting point if the mock
registry's actual fixture wording differs by the time this task runs — the fixture body is already
in the codebase (`web/src/nui/mocks/registry.ts`), not something this task invents.

- [ ] **Step 3: Run the full Blabber e2e spec**

Run: `pnpm test:e2e blabber`
Expected: PASS, all cases — including the ones Task 12 flagged as newly-failing (now fixed by
Step 1 above) and the new Search cases.

- [ ] **Step 4: Commit**

```bash
git add web/e2e/apps/blabber.spec.ts
git commit -m "test(blabber): e2e coverage for the flattened view, tags, and Search"
```

---

## Task 18: Docs — `docs/roadmap.md`, `web/README.md`, `README.md`

**Files:**
- Modify: `docs/roadmap.md`
- Modify: `web/README.md` (only if it enumerates something now stale)
- Modify: `README.md` (only if it enumerates something now stale)

- [ ] **Step 1: Move Search and hashtags from *Proposed* to *Shipped* in `docs/roadmap.md`**

Read the file's current *Proposed* section for "Search and hashtags" (renumbered to §1/§2 by the
earlier notifications-tab session) and its *Shipped* section's "Blabber — short public posts" entry
before writing anything — the exact heading text and surrounding structure may have shifted since
this plan was written. Write a new subsection under *Shipped*, sibling to "The notifications tab,
and the tab nobody could open," following that entry's own pattern: what shipped, and where it
differs from what was proposed. Specifically call out:

- The `root_id`/flattened-view rework — not in the original roadmap sketch, added because a search
  result can be a reply with no natural landing spot in the old nested-`Thread` navigation.
- `accounts:search` living on the shared `accounts` service rather than Blabber's, matching
  followers/following.
- The four-tab `TabBar` is now complete (Feed, Following, Notifications, Search).

Update the "Blabber, next iteration" decisions table's `Tabs` row (currently reads "...Search left"
per the earlier session's edit) to remove that qualifier.

- [ ] **Step 2: Check `web/src/apps/store/appInfo.ts`'s roadmap-path comment**

Confirm the comment still names a real path (`docs/roadmap.md`) — it should, since this task edits
that file rather than moving or renaming it. No change expected, but verify per AGENTS.md's "check
the paths a doc names actually exist" habit rather than assuming.

- [ ] **Step 3: Check `web/README.md` for stale suite/hook lists**

Read the file. If it enumerates e2e specs or server test files by name anywhere, add
`blabberRepository.test.ts` and `accountsSearch.test.ts` to that list. If it doesn't enumerate them
(many READMEs describe suites by directory rather than by filename), no change is needed — do not
invent a list that doesn't already exist.

- [ ] **Step 4: Check root `README.md`**

Read the file. It is server-owner-facing (features, requirements, DB import, `server.cfg`). If it
lists apps or features by name, confirm Blabber's entry (if one exists) doesn't understate what it
now does. A schema change here means `pnpm generate:sql` + re-import either way, which the file
should already document generically — do not add feature-specific migration instructions this
codebase's "day-zero schema" posture (AGENTS.md §8) doesn't otherwise give any other feature.

- [ ] **Step 5: `pnpm format:check` (Markdown is covered by Prettier)**

Run: `pnpm format:check`
Expected: PASS, or run `pnpm format` if it reports table-alignment or similar issues, then re-check.

- [ ] **Step 6: Commit**

```bash
git add docs/roadmap.md web/README.md README.md
git commit -m "docs(blabber): Search and hashtags — Proposed to Shipped"
```

(Only stage `web/README.md`/`README.md` if Steps 3–4 actually changed them.)

---

## Task 19: Full `pnpm verify`

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate**

Run: `pnpm verify`
Expected: PASS on every gate — `barrels`, `format`, `typecheck`, `unit`, `e2e`, `build`,
`deadcode` — in that order. Pay particular attention to `deadcode`: Task 12 flagged `replyTo` in
`index.svelte` as possibly orphaned, and this is the gate that would catch it if Task 12's own
check missed it.

- [ ] **Step 2: If `deadcode` flags anything**

Remove the flagged, genuinely-unused symbol (do not suppress the check) and re-run
`pnpm test:unit` for whichever file changed, then `pnpm verify` again from the top.

- [ ] **Step 3: Report**

State plainly which gates passed and which, if any, did not, per AGENTS.md §9 ("report failures as
failures"). Do not report the feature complete until this task's `pnpm verify` run is fully green.

No commit for this task — it is verification of everything already committed in Tasks 1–18.

---

## Plan Self-Review Notes

(Kept here rather than deleted, since it records decisions a reviewer might otherwise re-litigate.)

- **Spec coverage:** every section of the design spec maps to a task — data model → Tasks 2–3;
  `blabber:view` and its anchor mechanism → Tasks 4–5; the four search/tag actions → Tasks 6–8;
  client store → Task 10; navigation collapse → Tasks 11–12; tag tappability → Task 13; UI
  components → Tasks 11, 13, 15; `SearchBar` fix → Task 14; error handling → embedded in Tasks 5–8's
  null/empty-state handling and Task 11's `missing` branch; testing → a dedicated test step in every
  task plus Tasks 9, 17, 19; docs → Task 18.
- **Sequencing risk, called out explicitly:** Tasks 10–12 pass through an intermediate red
  typecheck state (Task 10 Step 6, Task 11 Step 3) because `store.ts`, `Thread.svelte`, and
  `index.svelte` are mutually dependent and cannot all change atomically in one task without the
  task becoming unreviewable as a single unit. This is deliberate — each task's own test step still
  passes in isolation — but a worker running these out of order, or stopping mid-sequence, will see
  a broken `pnpm typecheck:web` until Task 12 completes. Do not skip ahead.
- **`Search.svelte`'s `PagedStore.loaded` usage** was wrong in an early draft of Task 15
  (`$accountResults.loaded` instead of a separate `accountResults.loaded` subscription) — caught
  and corrected inline in that task's Step 1, matching the existing `feed.loaded` pattern in
  `index.svelte`. Left the correction visible rather than silently fixing it, since it is the kind
  of mistake worth a worker double-checking against `createPagedStore.ts`'s actual `PagedStore`
  interface before trusting this plan's snippet verbatim.
