# Blabber: search, hashtags, and a flattened Blab view

**Status:** approved, not yet implemented.
**Roadmap:** `docs/roadmap.md`, "Blabber, next iteration" §1 ("Search as the fourth tab") and §2
("Search and hashtags"). This spec supersedes §2's original sketch — it is closer to what actually
gets built, and the roadmap should be updated to point here once this lands, per AGENTS.md §2.11
("do not restate a plan in a second document — fix the first one").

## Why

Blabber's bottom nav has four intended destinations; three exist (Feed, Following, Notifications).
Search is the last one, and hashtags are currently render-only — `tokenizeRichText` emits a `tag`
token and `BlabBody` paints it as an inert `<span>`, with nothing to tap and nothing indexed to
search. This spec closes both gaps, and along the way replaces how a Blab is viewed at all: the
current `Thread.svelte` lets you drill an arbitrary number of levels deep into a reply's own reply
thread, pushing a new screen each time. That recursion has no natural landing spot for a search
result that's itself a reply, so this spec flattens it — every Blab, however you arrive at it, opens
one screen showing its full descendant thread with no further drill-down.

## Data model

### `gphone_blabber` gains `root_id`

A nullable `int`, FK to `gphone_blabber.id`, `clientWritable: false` — same discipline as the
existing `reply_to` and `mouth_of`: set once at create, never mutated by a generic update.

- Top-level post, or a mouth with no `reply_to`: `root_id = null`.
- A reply to a top-level post: `root_id = <that post's id>`.
- A reply to a reply: `root_id` **inherited** from the parent's own `root_id` (the parent, being a
  reply itself, already carries the true top-level ancestor there).

The inheritance is the whole point: it makes both queries this feature needs O(1) at any depth,
with no walk and no recursive query.

- **Flatten a subtree:** `WHERE id = :rootId OR root_id = :rootId`, indexed on `root_id`.
- **Find a reply's top-level ancestor:** `SELECT root_id FROM gphone_blabber WHERE id = ?` — if
  `root_id` is null, the row itself is the root.

Rejected alternatives (recorded so they aren't re-litigated): walking `reply_to` at read time
(unbounded round trips, no existing depth cap to lean on) and a recursive CTE (first one in the
codebase; FiveM servers run a range of MySQL/MariaDB versions via oxmysql and recursive-CTE support
isn't guaranteed across that range).

### New child table `gphone_blabber_tags`

DDL-only via `childTables`, matching `gphone_blabber_likes`'s shape:

```ts
childTables: [
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
];
```

Written once at create, from `taggedTopics(body)` — **fixed at creation**. An edit inside the
15-minute window (§10 `editWindow`) does not re-extract tags, matching that window's own framing as
a typo fix, not a rewrite.

### `taggedTopics(input): string[]`

A sibling of `mentionedHandles` in `shared/richText.ts`, built on the same `tokenizeRichText` and the
same dedup/lowercase discipline. What `BlabBody` highlights and what gets indexed cannot disagree,
for the same reason `mentionedHandles` already lives here rather than as a private regex somewhere
else.

### Trending

No new table. A windowed aggregate, recomputed per request:

```sql
SELECT t.tag, COUNT(*) AS uses
FROM gphone_blabber_tags t
JOIN gphone_blabber b ON b.id = t.blab_id
WHERE b.status = 'active' AND b.created_at > NOW() - INTERVAL 48 HOUR
GROUP BY t.tag
ORDER BY uses DESC
LIMIT 10
```

Not cached, not denormalized — it's a bounded aggregate over an indexed range, not a per-row count
with the drift problem `AGENTS.md`'s "Blabber is the worked example" section already warns against.

## Server actions

### `blabber:view` — the one way to open a Blab

Supersedes the `blabber:blab` action added in the notifications-tab fix (commit `545b93a`) and the
generic `get { reply_to }` call `Thread.svelte` currently makes. Both are replaced, not kept
alongside this.

Input: `{ id, cursor?, limit?, anchorId? }`. Server resolves the root (`root_id ?? id`), then:

- `root`: that Blab, hydrated (author, mouthed target) exactly as the feed already does.
- `replies`: the flattened subtree — `WHERE (id = :rootId OR root_id = :rootId) AND id != :rootId`,
  `id DESC`, keyset-paged like every other list in this codebase (§10). A heavily-replied post still
  can't return unbounded rows in one response.
- `nextCursor`: the usual keyset cursor, `null` at the end.

Every entry point into a Blab — a feed tap, a search result, a tag tap, a deep link — calls this and
gets the same screen.

**`anchorId` is what makes "opens the ancestor's view, scrolled to it" concrete rather than aspirational.**
Without it, the first page is always the newest `limit` replies by `id DESC` — correct for an
ordinary open, but a reply search result can be arbitrarily old and fall well past page one, with no
mechanism to reach it short of paging through the whole thread by hand. When `anchorId` is given (the
id of the reply the caller actually wants visible), the reply query becomes a window centered on it
instead of the newest slice: half the page from `id <= anchorId` descending, half from `id >
anchorId` ascending, merged back into `id DESC` order. `anchorId` is validated as a positive int and
must belong to the resolved subtree (`root_id = rootId OR id = rootId`) or is ignored — same "a
payload value is not proof it applies here" discipline as everywhere else in this file (§2.9). The
client scrolls the anchor row into view once that page renders; no further server capability is
needed, since the row is now guaranteed present in the first response.

### `accounts:search` (in `Accounts.ts`, not `Blabber.ts`)

`{ app, q, cursor?, limit? }`. `handle LIKE ? OR display_name LIKE ?`, scoped to `app`, through the
same `publicColumns` projection every public account read already uses — `citizenid` withheld
automatically. Placed on the shared accounts service rather than Blabber's because identity is
shared (§10, "Identity: one accounts table, shared") and a future social app gets the same search for
free, the way followers/following already work that way.

This is explicitly **not** a way to discover which accounts share an owner: the query has no
`citizenid` in it, and the projection withholds it from the result the same as it does everywhere
else. It answers "find the account named X," nothing more — the same fact a handle button anywhere
else in the app already exposes.

### `blabber:search`

Body search. `{ q, cursor?, limit? }`, `body LIKE ?`, `id DESC`, **no** `reply_to` filter — unlike
the feed and Following, this includes replies, per the explicit scope decision: a search should find
what was said, not just what was said at the top level. A reply result opens through `blabber:view`
the same as everything else, landing on its flattened root screen.

### `blabber:searchTags`

Tag-**name** search (prefix match: `tag LIKE ?%`), returning `{ tag, uses }` rows — the list the
Tags segment of the Search tab shows as you type. Not a body search; it answers "which hashtags
match this," and tapping a row goes to `byTag`.

### `blabber:byTag`

`{ tag, cursor?, limit? }` — Blabs carrying one exact tag, same paged shape as the existing `profile`
action. The single shared landing spot for three different entry points: a Tags-search result, an
inline `#tag` tap inside any `BlabBody`, and a trending-chip tap. One action, one screen, three ways
in.

### `blabber:trendingTags`

No cursor — it's a bounded top-10 snapshot, not a list a player pages through.

Every `q`/`tag` value across all five actions is bound as a query parameter, never interpolated
(§2.9), matching how `profile` and `following` already build their WHERE clauses.

## Client

### Store (`web/src/apps/blabber/store.ts`)

- `viewBlab(id)` wraps `blabber:view`, replacing today's `loadBlab` + `loadThread` pair.
- One paged store per search kind: `accountResults`, `blabResults`, `tagResults`. Each rebuilds on
  query change rather than reusing `createPagedStore`'s single-filter reload model — a new query
  string is a new list, not a filter refinement on the one already loaded.
- `trendingTags` — a plain `writable`, loaded once when the Search tab opens (not paged).
- `loadTaggedBlabs(tag)` wraps `byTag`, paged the same way `followingFeed` already is.

### Navigation: one screen, not a stack

`index.svelte` currently holds `threads: Blab[]` and pushes a new `Thread` level per tap into a
reply. That collapses to a single `activeBlabId`. Every "open a Blab" call site — feed row, search
result, tag tap, deep link — sets it and renders one `BlabDetail` screen. Tapping a reply **inside**
that screen does nothing navigational (per the resolved design question): the reply is already
flattened into the same list, so `BlabRow`'s `onopen` is not wired for it — Ear/Mouth/reply-inline
stay live, opening a new screen does not happen.

`useAppLevels`' thread rungs simplify from the current pair ("pop one thread" / "clear the stack")
to one rung, since there is only ever one level now.

A search result that is itself a reply opens `blabber:view` with `{ id, anchorId: id }` — its own id
as the target and as the anchor. The server resolves the root from `id`, and the anchor mechanism
above (§ "blabber:view") guarantees the reply itself is in the first returned page regardless of how
old it is. The client scrolls it into view once that page renders.

### Tag taps: one callback, threaded like `onhandle`

`ontag(tag)` threads through `BlabBody` → `BlabRow` → `Thread`/`BlabDetail`/`Messages` (DM), the same
path `onhandle` already takes. It calls `loadTaggedBlabs` and opens a screen titled `#tag`, using the
existing overlay pattern `follows`/`profile` already use rather than inventing a new one.

## UI components

- **`Search.svelte`** (new, `blabber/components/`): `SearchBar` + `SegmentedControl` (People / Blabs
  / Tags) + a trending-chip row shown only while the query is empty. No request fires below 2
  characters.
- **`SearchBar.svelte`** (`sdk/ui/`): `use:focus` is currently an empty stub (`// Optional autofocus
could be added here if needed`). Fixed to call `node.focus()` while this feature is in the file.
- **`BlabDetail.svelte`** (new, replaces `Thread.svelte`'s job — that file is deleted, not kept
  alongside): root Blab, then the flattened paged reply list via `usePagedList`, same `olderAt: 'end'`
  shape a feed uses. Replies render through `BlabRow` with `onopen` omitted.
- **`BlabBody.svelte`**: the tag `<span>` becomes a `<button>` calling `ontag`, mirroring the existing
  mention `<button>` immediately above it in the same `{#each}`.
- Tag rows (Tags segment, trending chips) reuse a small `#tag · N Blabs` row local to `Search.svelte`
  — no new SDK primitive needed for this.

## Error handling

- `blabber:view` on a deleted/moderated id: `root: null`, same as the existing `blabber:blab`
  null-and-"unavailable" pattern from the notifications-tab fix — carried forward, not reinvented.
- Empty search results: the existing `EmptyState`, worded per segment ("No people found" / "No
  Blabs found" / "No tags found").
- A stale root scrolled-to reply that has since been deleted/moderated: it simply isn't in the
  returned page: no special-case, since the flattened list is re-fetched fresh each open.

## Testing

Server (§9, new suite alongside `blabber.test.ts`):

- `root_id` inheritance at three depths: top-level (`null`), reply-to-top-level, reply-to-reply
  (inherits the grandparent's root, not the immediate parent's id).
- `blabber:view`: flattening, paging of the reply list, and the null-root case.
- Each search action's parameter binding (no interpolation) and its projection (`accounts:search`
  never returns `citizenid`, matching every other public account read).
- `blabber:byTag` exactness — a tag search for `#car` must not match `#cars` or `#carpet`.
- Trending's window boundary — a Blab just outside 48h does not count; one just inside does.

E2e (`blabber.spec.ts`):

- Opening a Blab from the feed and from a search result lands on the same flattened screen.
- Tapping a reply inside that screen does not navigate.
- Tapping a tag inline in a body, and tapping the same tag from the Tags segment, both land on
  `byTag`'s screen.
- A query under 2 characters fires no request (mock call-count assertion).
- Trending chips render before typing and disappear once a query is entered.

## Docs to update alongside this

Not an afterthought — `docs/roadmap.md`'s own rule (§2.11, "fix the doc in the same change") applies
here same as it did for the notifications-tab fix:

- **`docs/roadmap.md`**: move Search and hashtags from _Proposed_ to _Shipped_, following the same
  pattern the notifications-tab entry used — what shipped, and where it differs from what this spec
  or the original proposal said (the `root_id`/flattened-view rework in particular, since that
  wasn't in the roadmap's original sketch at all). Update the "Blabber, next iteration" decisions
  table's Tabs row once Search is real. Check `web/src/apps/store/appInfo.ts`'s comment about the
  roadmap path still points somewhere true.
- **`web/README.md`**: covers `web/` structure and which suites cover what — add the new
  `blabber.test.ts`-adjacent server suite and any new e2e cases to whatever list currently enumerates
  them, if one does. Verify against the file rather than assuming a list exists.
- **`README.md`** (root, server-owner-facing): only touch if something here changes what a server
  owner does — a new table means `pnpm generate:sql` and a re-import either way (§8), which the file
  already documents generically; check whether it enumerates apps or features by name anywhere that
  would now be stale.

Per AGENTS.md's "check the paths a doc names actually exist" habit: verify every path and count named
above still matches the tree before considering this step done, not just that the words changed.

## Explicitly out of scope

- Any notion of "which accounts belong to the same player" — not built, and `accounts:search`'s
  projection makes it structurally unable to answer that question.
- A depth or fan-out cap on the reply tree itself (as opposed to paging the flattened list) — the
  flattening already removes the UI cost of depth; nothing in this spec needs a hard limit on how
  many replies a Blab can accumulate.
- Re-extracting tags on edit.
- Caching or denormalizing the trending count.
