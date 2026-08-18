# Schema changes and declaring a service

The long version. [`AGENTS.md`](../AGENTS.md) keeps only the rules that apply every session —
this is where the rationale behind them lives, so it doesn't get re-read on every turn.

## Schema changes

**A schema change is written once, in the declaration.** Change the `defineService` schema and
run `pnpm generate:sql`: that regenerates `gphone.sql`, which is what a fresh install imports and
is always the whole truth. Nothing happens to a live database on its own — not at import, not at
resource start. An install that already has data is brought up to date by **`gphoneschema apply`**
from the server console, the only thing in this resource that changes a live schema.

`apply` runs two halves in one pass, in this order and not the other:

1. **Versioned migrations** — every file in `server/migrations/` the `gphone_schema_migrations`
   ledger has no row for, oldest id first. `server/lib/migrations.ts`.
2. **The additive pass** — `SchemaMigrator.apply()` executing the `ADD COLUMN` / `ADD KEY`
   statements `plan()` derives from the difference between `information_schema` and the
   declarations. `server/lib/SchemaMigrator.ts` over `server/lib/migrate.ts`.

One command rather than two, because an operator thinks "bring my database up to date", not
"apply the two kinds of change separately".

**Migrations first is a correctness constraint, not a preference.** The additive planner compares
the live table against the declaration, and the declaration already describes the shape the
migration is about to produce. Run the additive pass first and a migration renaming `image` to
`data` never gets its chance: the planner sees `data` declared, finds no such column live, adds an
empty one, and the rename then dies on a duplicate column with the real data stranded under a name
nothing reads. A failed migration aborts the command before the additive pass runs at all, for the
same reason — a half-migrated table is the one shape the planner cannot reason about.

**Versioned migration files, not a smarter planner.** A rename, a retype, a widened enum or a drop
is not inferable from a diff: a renamed column is indistinguishable from one dropped and another
added. The planner reports those as `drift` and never touches them, `defineService` stays purely
declarative — it describes the schema's current shape and carries no history — and the history
lives in `server/migrations/`, one file per breaking change. TypeScript rather than `.sql`, because
`server/` is typechecked and because this codebase already moved away from hand-written per-app SQL
files once (the old `sql/apps/`); a directory of hand-written SQL migrations would be a step back
toward it. Forward-only: fixing a bad migration is a new migration, not a reversed old one, and a
`down` for a narrowed varchar or a dropped column cannot be written honestly anyway.

**MySQL DDL is not transactional, and neither half pretends otherwise.** `ALTER TABLE` and
`RENAME TABLE` auto-commit in InnoDB regardless of any surrounding transaction, so a migration of
three statements is not all-or-nothing the way a row-data transaction is. Both halves therefore
**stop at the first failure** — retrying blind would re-run whatever already succeeded before it —
and both return `{ applied, failed, remaining }` rather than rejecting, deliberately the same shape
in `runMigrations` and `SchemaMigrator.apply()`. Throwing away the list of what already ran is not
an option in the one command that changes a live database. A migration reaches the ledger only
after its `up()` returns; a ledger write that fails _after_ a successful `up()` says exactly that,
because it is the one failure where retrying without looking at the table first is unsafe.

**A fresh install never runs inherited migrations.** `gphone.sql` declares every table in its final
shape already, so a migration renaming a column would meet a table that never had the old name on
this install. `pnpm generate:sql` scans `server/migrations/` and pre-seeds the ledger with every id
that exists as of that generation, via `INSERT IGNORE` — the way Rails' `schema.rb` does. A new
install's ledger reads "already applied" for all of history without ever calling `up()`, and only a
database upgrading from an older `gphone.sql` has gaps for the runner to fill.

**`apply` is console-only**, and the check is `source === 0` inside `runApply` itself rather than
only at the command dispatch. That is the trust tier AGENTS.md §1 already draws, and it is the one
caller that can take a backup first, which an in-game admin typically cannot. `gphoneschema` with
no subcommand still only reports, and so does the report at resource start: neither creates a
table, the migrations ledger included. Worth stating because it was broken once — the boot report
created the ledger, which is real DDL from a function whose docstring promised it applied nothing.

The expected shape of a table comes from `expectedShape()` in `server/lib/schemaSql.ts`,
which both the `CREATE TABLE` generator and the migration planner read. Do not restate a
table's columns anywhere else: a fresh install and an upgraded one must not be able to
disagree.

**In development none of this is the fast path.** Against a database you do not mind losing,
`pnpm generate:sql:reset` writes the file that drops every `gphone_` table and rebuilds the schema
— one import, no migration to write and review.

### Writing a migration

One file in `server/migrations/`, named `NNNN_snake_case_description.ts`, and **the filename is the
id**. The directory is empty today — nothing has needed a breaking change since the runner shipped —
so the example below is the one rename this codebase did make, `gphone_media.image` to `.data`, back
when wipe-and-reimport was the only way to do it:

```ts
import { Database } from '../lib/Database';
import type { Migration } from '../lib/migrations';

export const migration: Migration = {
  id: '0001_rename_media_image_to_data',
  description: 'gphone_media.image becomes gphone_media.data',
  up: async () => {
    await Database.query(
      'ALTER TABLE `gphone_media` CHANGE COLUMN `image` `data` mediumtext DEFAULT NULL',
      []
    );
  }
};
```

- The export is named `migration`, exactly. `scripts/generate-barrels.js` imports that name from
  every file in the directory to build the ordered array in `index.ts`.
- `id` must equal the filename stem — `server/__tests__/migrationsSeed.test.ts` fails otherwise —
  and the number is apply order. Ids sort as strings, so keep the width.
- **Re-run `pnpm generate:sql` after adding one.** Without it the ledger seed in `gphone.sql` does
  not name the new migration, and every fresh install runs it against a table that never needed it.
  Same test catches this.
- `server/migrations/` holds migration files and the generated `index.ts`, nothing else. The barrel
  imports `migration` from every `.ts` in there that is not `index.ts` or a `.test.ts`, so a helper
  module parked beside them breaks the generated file.
- `up` calls `Database.query` directly, the same convention as the rest of `server/lib`. It is not
  reached by a repository: a migration is about the shape of a table, not about rows a player owns.
- `Migration` comes in as `import type`. A value import of `server/lib/migrations.ts` would close a
  runtime cycle — that module imports the barrel, which imports this file.

## Declaring a service

A service is a named group of server actions, usually backed by a table. Most apps have one;
some services (`shell`, `phone`) have no app, and some apps (Calculator) have no service.

Declare it once instead of hand-writing a repository and an endpoint.
`server/lib/defineService.ts` derives everything from one schema:

```ts
export const notes = defineService<Note>({
  id: 'notes', // matches the app manifest id, and the <service> event segment
  access: { read: 'owner', write: 'owner' },
  statuses: ['active', 'archived', 'deleted', 'moderated'],
  schema: {
    title: { type: 'string', length: 255 },
    content: 'text'
  },
  indexes: [['citizenid', 'status', 'updated_at']]
});
```

**Why one declaration and not two lists.** The `columns` allowlist from AGENTS.md §2.9 is only
_safe_ if it matches the real table. Keeping `gphone.sql` and a hand-written `columns` array in
sync by hand means a silent divergence breaks either security or writes. One schema drives both,
plus the generated DDL.

- `id, citizenid, status, created_at, updated_at` are **supplied by the framework**. Declaring any of
  them in `schema` is an error.
- Declared fields are client-writable by default; opt out with `clientWritable: false`. Filtering is
  opt-in via `clientFilterable: true`.
- **`access` is two axes, not one.** It replaced a single `scope`, which conflated them — the thing
  Conversations' own header had been complaining about: the row genuinely has an owner, and what is
  shared is _visibility_. A table can need ownership-scoped writes and membership-scoped reads at the
  same time, and one value could not say that. Defaults to `{ read: 'owner', write: 'owner' }`.
  - **`read: 'owner'`** forces the caller's citizenid into the WHERE.
  - **`read: 'public'`** drops the ownership predicate: any authenticated player reads every
    active row. **It requires `paging`, and `defineService` throws without it** — which is the
    highest-value rule in the file. `Repository.findAll` returns every matching row, and until
    a public table existed the only thing bounding that was the citizenid predicate. A public
    read has no per-player bound, so an unpaged one is the whole table.
  - **`read: 'members'`** does not register the generic `get` at all. A membership read needs the
    parent id, and the generic filter path has no way to require one — so the endpoint the old
    `shared` scope left registered could only ever have answered by ownership.
  - **`write: 'owner'`** scopes create/update/delete by the row's citizenid.
  - **`write: 'server'`** means rows arrive from the server, never the phone's owner — mail from a
    job, a dispatch, a bank alert. Nothing becomes client-writable and create/update are not
    registered. Delete stays, because the row still belongs to exactly one citizenid.
  - **`write: 'members'`** registers no generic mutation at all, for the same reason as the read.
- **`access.editWindow` (seconds) time-boxes the ownership-scoped update.** For "fix a typo",
  not "rewrite history". A predicate in the same `UPDATE` rather than a check before it, so
  there is no gap between deciding and writing; both sides of the comparison are the database's
  clock, so it is immune to server/client skew. **It never applies to `delete`** — removing your
  own post stays possible forever, and the first version of this shared one code path and
  silently made an expired post undeletable. Declaring it on anything but `write: 'owner'`
  throws, since nothing else goes through the update it constrains.
- **An owner cannot write over a `moderated` row.** The ownership-scoped update carries
  `status != 'moderated'`. The row is already out of every read, so it is not a visibility hole
  alone — but without it an author keeps rewriting a moderated post, and a moderator who later
  reinstates it reinstates text nobody reviewed. Only `moderated`: excluding `deleted` would
  make deleting an already-deleted row report failure, and excluding an app's own away-state
  (Notes and Conversations both declare `archived`) would break editing a row merely put away.
  `updateUnscoped` is exempt, because moderating and un-moderating are the writes that must
  reach those rows.
- **`ColumnDef.private: true` withholds a column from a public read's projection**, and
  `citizenid` is withheld from every public projection automatically without being declared.
  That is not hygiene: a public table returns rows the reader does not own, and once a player
  can hold several accounts in one app, the owner's citizenid correlates two
  deliberately-separate identities back to one person — which is the entire thing an alt
  account exists to prevent. Enforced in the `SELECT`, not by dropping keys from the returned
  rows, so a `repositoryFactory` override cannot re-add a column the query never named. A
  client establishes "this is mine" from ids it already holds; the server authorizes writes
  from the session regardless.
- **`paging` is keyset, on `id DESC`, and the order is not configurable.** Four reasons, and
  they all come from `id` being the primary key: in InnoDB it _is_ the clustered index, so the
  scan needs no sort step; every primary table already emits `KEY status (status)` and InnoDB
  appends the PK to every secondary index, so that key is physically `(status, id)` and the feed
  query is a plain range scan on something already shipped; the cursor is one column and needs no
  tie-break, where a `created_at` cursor needs `(created_at < ? OR (created_at = ? AND id < ?))`
  because the column is second-resolution and the naive form silently drops a row at every page
  boundary; and `id` never changes, so editing a row cannot reorder a feed under a reader.
  Not offset paging either — a feed takes inserts at the head, so `OFFSET N` skips and duplicates
  across pages, and nothing in the phone has a jump-to-page control to pay for that with.
  - Wire shape is a payload concern, so `get` stays `get` and `shared/routes.ts` needs nothing:
    `{ cursor?, limit? }` in, `{ rows, nextCursor }` out. `nextCursor: null` means the end, and
    a client must be able to tell that from "ask again" or the scroll never terminates.
  - The cursor is a **bare row id**, validated by `requirePositiveInt`. It needs no signing — it
    names a position in a result set the caller is already authorized to read — but it must never
    name a _column_: the sort column comes from the declaration, and a payload offering one is
    ignored rather than honored.
  - An over-large `limit` is clamped to `maxPageSize` rather than rejected. The request is
    legitimate; only the number is not.
  - **A custom action pages itself, so it clamps itself** — `ServiceEndpoint` only wraps the generic
    `get`. Use `pageBounds(data, service.resolved.paging)` from `server/lib/payload.ts` rather than
    writing the four lines again, and pass the resolved declaration rather than retyping the numbers:
    that is what stops a change to a `paging` block from silently missing that service's own actions.
    `id DESC` still, and the cursor is still the row id of whichever table the query walks — for a
    join that is the **driving** table, not the one being joined on. Blabber's `profile` and
    `following` and the accounts service's `followers` and `following` are the four worked examples.
- **`access.membership` declares how membership is decided, as data.** Never a SQL fragment: §2.9's
  identifier allowlist has to extend across the join, and a caller-supplied `where` is the exact hole
  it exists to close. `{ table, foreignKey, localKey?, citizenColumn?, liveWhileNull? }` derives the
  inherited `Repository.isMember`, which is what a custom action calls.
  - `localKey` is what makes it general rather than a Conversations special case. A conversation's
    membership is keyed on its own `id`; a _message_'s on its `conversation_id`. Same join table,
    different local column — without it, Messages was inexpressible.
  - Declaring `membership` with neither axis set to `members` is **allowed**, and Conversations is
    why: its generic writes really are owner-scoped, while `read`/`archive`/`delete` are custom
    actions that check participation. Rejecting that would push it back to a hand-written predicate.
  - `liveWhileNull: 'left_at'` is the liveness rule. It used to be re-typed into every participants
    query by hand; omitting it means a player who left a thread can still act on it.
- `indexes` takes full ordered column lists, either bare (`['citizenid', 'status']`, named by joining)
  or explicit (`{ name: 'citizenid_status_updated', columns: [...] }`). Prefer explicit: the derived
  name is what appears in EXPLAIN output, and MySQL caps index names at 64 characters. A name that
  collides with one the primary table already emits (`status`, `citizenid_status`) is rejected at
  declaration time — it would otherwise be MySQL error 1061 at apply time.
- `default` on a field emits a SQL default. Set it when migrating an existing table —
  `favorite tinyint(1) DEFAULT 0` behaves differently from `DEFAULT NULL` once anything aggregates.
- **`table` overrides the table name; the default is `gphone_<id>`.** Two apps may not declare the
  same table, and the check is on the resolved name rather than the id.
- **`options` passes through to `ServiceEndpoint` to turn a generic action off** —
  `{ disableGet, disableCreate, disableUpdate, disableDelete }`. Reach for it when the generic
  shape is not merely incomplete but wrong: Blabber disables `create` because a post has to prove
  the account it claims belongs to the caller, and Blabber DMs additionally disables `update`
  because a sent message is not editable, so there is nothing for it to do. Some of these are set
  for you — `read: 'members'` implies `disableGet`, `write: 'server'` implies no create or update
  — and declaring one that is already implied is harmless.
- **An index may be `unique: true`.** Either form takes it: `{ name, columns, unique: true }`.
  It is a constraint, not an optimisation, and it is the right tool where the alternative is
  find-then-insert with a race two rapid taps will find — Blabber's one-mouth-per-account and one
  like per account per post are both enforced this way, and both translate the driver's duplicate
  error into something a player can read. A unique index over a nullable column constrains only
  the non-null rows, which is what makes `(account_id, mouth_of)` safe on a table where ordinary
  posts have no `mouth_of` at all.
- Per-column `index: true` is shorthand for an index paired with `citizenid`. Right for an
  owner-scoped table, dead weight on a public one that never filters by owner — declare those
  explicitly instead.
- The generic filter now understands null: `{ reply_to: null }` emits `IS NULL`. There is still no
  equality meaning "has a parent", which is why Blabber's profile tabs are a custom action.

### Identity: one accounts table, shared

`gphone_accounts` (`server/services/Accounts.ts`) is the identity every social app posts under — a
handle, a display name, an avatar, a bio — with `app` as a column rather than one table per app,
because those fields do not differ between a Twitter-alike and an Instagram-alike. An app-specific
_presentation_ field, if one ever genuinely exists, goes in its own table keyed on `account_id`.

Two consequences worth knowing before building on it:

- **A player may hold several accounts per app**, so nothing keyed on identity here is
  one-per-citizenid. `citizenid` stays the ownership anchor and never leaves the server; the
  display identity is `account_id`. This is the concrete reason `private`/`publicColumns` exists
  above — a public read that carried the citizenid would correlate two deliberately-separate
  identities back to one person.
- **A payload naming an account is not proof of owning it.** `ownedAccount(id, citizenid, app)` is
  the check, and every action that writes as an account calls it first (AGENTS.md §2.9). Without it
  a player posts under anyone's handle by guessing an id.
- **But a _read_ about an account is usually nobody's to own.** `followers` and `following` have no
  ownership check on purpose: requiring one would mean you could only see your own followers, which
  is not what the count on a stranger's profile is counting. What has to hold instead is the
  projection — `publicColumns`, so `citizenid` is withheld. A follower list is the single screen that
  would otherwise correlate every alt in the graph back to one person, so the rule to carry over from
  a write is "check the projection", not "check the owner".

`handle` is `clientWritable: false` and claimed once: renaming it would silently break every
mention of it, and there is nothing to un-break it with.

### Blabber is the worked example of a public read

`server/services/Blabber.ts` is the first table in this codebase whose rows are readable by players
who do not own them, so it is the first real consumer of nearly everything in this section:
`read: 'public'` with mandatory keyset paging, `access.editWindow`, `publicColumns` withholding
`citizenid`, and the accounts table above. Read it before writing another public service — the
comments there record which decisions were forced and which were free.

A reply and a **mouth** (a repeat; with a body, a quote) are both self-references on the same
table rather than tables of their own, because a reply is a Blab and a mouth is a Blab: they
inherit the feed, the paging, the edit window and the moderation predicate instead of duplicating
them. Counts are read in one batched `engagement` action rather than three per row, and are
deliberately **not** denormalised onto the Blab row — a `like_count` column is a second copy of a
fact the likes table already holds, and it drifts the first time a like is removed by a path that
forgets to decrement.

`server/services/BlabberDms.ts` is one-to-one **by construction**: two account columns and no
participants table, so there is no shape a third person could be added to. Contrast Conversations,
which needs a join table precisely because a thread there can grow, and pays for it with `left_at`,
roles, and a membership predicate in every query. Reach for `access.membership` when a thread can
grow; reach for two columns when it cannot.

### Apps that own more than one table

The primary `schema` describes a table in the standard gPhone shape: `id`, `citizenid`, `status`,
`created_at`, `updated_at` supplied by the framework. Join and attachment tables do not fit that —
`gphone_messages_participants` carries `role`, its own status enum and two nullable timestamps;
`gphone_messages_attachments` carries neither `status` nor timestamps. Declare them as `childTables`:

```ts
childTables: [
  {
    name: 'gphone_messages_attachments',
    columns: {
      message_id: {
        type: 'int',
        notNull: true,
        references: { table: 'gphone_messages', column: 'id' }
      },
      photo_id: { type: 'int', notNull: true, references: { table: 'gphone_media', column: 'id' } }
    },
    indexes: [['message_id']]
  }
];
```

- **DDL-only.** No repository is derived and no events are registered — a child table is reached
  through named methods on the primary repository. Its point is that `pnpm generate:sql` emits a
  **complete** schema; without it the generated file looks authoritative while leaving dangling
  foreign keys, which is worse than no file.
- **Nothing is implicit.** Declare every column. `autoIncrementId: false` drops even the `id`.
- Child tables are emitted after the primary table so foreign keys resolve.

Use the full column vocabulary when mirroring an existing table, or the generated DDL is quietly
weaker than the real one: `type: 'enum'` with `values` (a varchar stand-in drops the database-level
constraint), `defaultNow` and `onUpdateNow` for timestamps (omitting `onUpdateNow` on an `updated_at`
produces a column that never moves), and `references` for any FK that is not `citizenid`.

### When an app needs custom repository behavior

`repositoryFactory` receives the resolved schema; subclass the exported `SchemaRepository` so the
result still inherits the identifier allowlist and the ownership scoping. Overriding a read is
additive — it is not a way around §2.9, and there are tests asserting that.

```ts
repositoryFactory: (resolved) =>
  new (class extends SchemaRepository<Photo> {
    async findAll(where: Partial<Photo> = {}) {
      return (await super.findAll(where)).map(coerceImage);
    }
  })(resolved);
```

Media uses this because `image` can come back as a Buffer depending on driver and column type, which
would cross NUI as `{type:'Buffer',data:[...]}` and render as nothing.

### Generating `gphone.sql`

**`gphone.sql` is generated in full and must not be hand-edited.** It holds the framework half — the
audit ledger, which has no owning module and does not fit the app-table shape, and which lives in
`scripts/framework-schema.sql` — followed by every app table in dependency order. Editing the output
reintroduces exactly the drift the generator removes, and a stale copy silently breaks the `columns`
allowlist's safety property (AGENTS.md §2.9): that allowlist is only sound while it matches the real
table.

It used to be `gphone.sql` plus one numbered file per service in `sql/apps/`, imported in filename
order because foreign keys cross app boundaries. That worked and cost three things: a rule every
server owner had to be told, a numeric prefix that renumbered existing files whenever an app was
added, and two places to look for one schema. One file in the order the generator already computed
removes all three.

#### The dev reset

`pnpm generate:sql:reset` additionally writes `sql/dev-reset.sql`: a single file that **drops every
`gphone_`-prefixed table in the schema it is run against** — audit ledger included — then recreates the
whole schema. Development only.

- It discovers tables at apply time from `information_schema` rather than listing the declared ones,
  because the point is to clear orphans left by a renamed or deleted declaration.
- Scoped by `table_schema = DATABASE()`, so it cannot reach another schema, and it no-ops if no
  database is selected.
- **Gitignored on purpose.** A committed "wipe everything" file is a footgun for anyone who clones the
  repo. Regenerate it when you need it.
- Never emitted by plain `pnpm generate:sql` — the flag is required.
- Nothing in this repo connects to a database. Apply the file yourself in a DB client; it uses
  `PREPARE`/`EXECUTE`, so it will not run through oxmysql.

`pnpm generate:sql` writes `gphone.sql`, which is **committed and imported by hand**. No app table
is ever created at runtime: `CREATE TABLE IF NOT EXISTS` silently does nothing against an existing
table, so a schema change applied that way would be a no-op with no error — the same silent-failure
shape as a missing NUI layer. Regenerate and review the diff.

What a running server _can_ do is bring an existing table up to date, and only when an operator asks
it to by name: `gphoneschema apply` runs the versioned migrations and then the additive plan. Its one
`CREATE TABLE IF NOT EXISTS` is the `gphone_schema_migrations` ledger, which is exempt from the
objection above because it has a single fixed shape and will never gain a column — "already there"
really is nothing to do, rather than a change quietly skipped.

**The numeric prefix is apply order, and alphabetical would be wrong.** Foreign keys cross app
boundaries — `gphone_messages_attachments` references `gphone_media`, and `messages` sorts before
`photos`; `gphone_blabber` references `gphone_accounts`. `orderAppsByDependency` in
`scripts/generate-sql.js` topologically sorts the declared services and numbers the files, so
globbing the directory or importing it in name order is correct by default rather than correct if
you happen to read the DDL first. Targets nothing owns (`players`) are external and do not
constrain the order. The prefix is positional, so **adding an app can renumber existing files** —
that is a real diff, not a spurious one, and stale output is deleted rather than left to orphan.

Every gPhone-owned table is now declared. `server/repositories/` holds `SchemaRepository` subclasses
for the two apps with multi-table queries — the declaration owns the schema, the subclass owns the
joins the single-table generic path cannot express.

### Never read another resource's tables

Some data gPhone displays belongs to a different resource — bank transactions to the banking script,
character data to the core. **Go through that resource's exports, behind a `*Bridge` in `server/lib/`.**
Querying their tables directly couples gPhone to a schema it does not own, breaks on their migrations,
and can read stale data: Renewed-Banking keeps transactions in an in-memory cache that
`player_transactions` lags behind, so the export is both correct and fresher than the table.

A bridge's other job is to **normalize**, because these resources disagree in ways that fail silently.
Renewed stores `amount` as a positive magnitude with the direction in `trans_type`; anything inferring
direction from a negative amount renders every withdrawal as a credit. Normalize onto the
`shared/types.ts` shape at the boundary, keep the pure mapping in an exported function so it is
testable without a running server, and make the mock emit the same normalized shape — otherwise `pnpm
dev` disagrees with production and hides the bug.

Such an app has **no table and no declaration**: pass `null` as the repository to `ServiceEndpoint` and
disable every generic CRUD action. `Bank` is the worked example.
