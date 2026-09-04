---
name: mica-service
description:
  Declare or change a server service, table, or schema. Use when adding a
  defineService declaration, changing a column, adding an index, writing a
  migration, exposing a public or membership read, or wiring an app to a
  resource it does not own. Covers mica.sql generation and micaschema apply.
---

# Declaring a service, and changing a schema

A **service** is a named group of server actions, usually backed by a table,
declared once via `server/lib/defineService.ts` — never a hand-written
repository plus endpoint. One declaration derives the repository, the write
allowlist, the CRUD net events, and the DDL.

`docs/schema-and-services.md` is the authority — every field, the
accounts/identity model shared social apps build on, Blabber as the worked
public-read example, and the `mica.sql` generation and dev-reset mechanics. Read
it before your first `read: 'public'` or `access.membership` service.

## The declaration

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

- `id`, `citizenid`, `status`, `created_at`, `updated_at` are **supplied by the
  framework**. Declaring one in `schema` is an error.
- `access` is two independent axes. `read` and `write` are each `'owner'`
  (default), `'public'`, or `'members'`; `write` also takes `'server'`.
- **`read: 'public'` requires `paging`** — `defineService` throws without it,
  since an unpaged public read returns the whole table.
- `'members'` and `'public'` reads register no generic `get`. Membership needs
  `access.membership`
  (`{ table, foreignKey, localKey?, citizenColumn?, liveWhileNull? }`), which
  derives `Repository.isMember`.
- `access.editWindow` (seconds) time-boxes an **ownership-scoped update only**,
  never `delete`.
- `ColumnDef.private: true` withholds a column from a public read's projection.
  `citizenid` is withheld from every public projection automatically.
- `paging` is always keyset on `id DESC` — never offset, never configurable.
  `{ cursor?, limit? }` in, `{ rows, nextCursor }` out, `nextCursor: null`
  meaning end of list.
- `childTables` declares join/attachment tables: DDL only, no repository or
  events derived. Declare every column explicitly.
- `repositoryFactory` subclasses `SchemaRepository` for reads the single-table
  generic path cannot express, without losing the identifier allowlist or the
  ownership scoping. `server/repositories/` holds the two that need it.
- `table` overrides the default `mica_<id>`; `options` (`disableGet`,
  `disableCreate`, …) turns off a generic action the shape doesn't fit.

**An app with no table** — Bank — has no declaration: pass `null` as the
repository to `ServiceEndpoint` and disable every generic action.

## Security is not optional here

Every field and row id in a payload is attacker-controlled, and a registered net
event is reachable whether or not the app calls it. The declaration is what
makes the guarantees hold:

- **Never interpolate a payload key into SQL.** MySQL cannot parameterize an
  identifier, so keys are checked against the repository's `columns` allowlist,
  derived from the declaration.
- **Never mutate a row without an ownership predicate.** A row id is never
  authorization. Shared rows check `Repository.isMember`. Privileged writes get
  a **named** repository method over `protected updateUnscoped` — never a
  service-level bypass.
- `clientWritable` declares the writable set per table; `id`, `citizenid`,
  `created_at`, `updated_at` never are, and `status` is excluded everywhere.
- Do not register a generic action the app does not use.
  `server/__tests__/reachability.test.ts` enforces that.

Full model: `docs/security.md`. Constraints: AGENTS.md §2.9.

## Changing a schema

**Write the change once, in the declaration**, then `pnpm generate:sql`.

`mica.sql` is generated in full, committed, and **imported by hand**. Never
hand-edit it — a stale copy silently breaks the `columns` allowlist, whose
safety property holds only while it matches the real table. No app table is ever
created at runtime.

A live install is brought up to date by **`micaschema apply`** from the server
console (console-only, `source === 0`). It runs versioned migrations
oldest-first, **then** the additive `ADD COLUMN` / `ADD KEY` pass — that order
is a correctness requirement, not a preference: run the additive pass first and
a rename finds an empty column already sitting under the new name with the real
data stranded. MySQL DDL is not transactional, so both halves stop at the first
failure rather than retrying blind.

In development, against a database you don't mind losing:
`pnpm generate:sql:reset` writes a drop-and-rebuild file. **Ask before running
it** — it is destructive, and the output is gitignored on purpose.

### When you need a migration

A **rename, retype, widened enum, or drop** is not inferable from a diff — the
planner reports those as drift and never touches them. One TypeScript file per
breaking change in `server/migrations/`, `NNNN_snake_case_description.ts`:

```ts
export const migration: Migration = {
  id: '0001_rename_media_image_to_data',
  description: 'mica_media.image becomes mica_media.data',
  up: async () => {
    await Database.query('ALTER TABLE `mica_media` CHANGE COLUMN ...', []);
  }
};
```

- The export is named `migration`, exactly — the barrel generator imports that
  name.
- `id` must equal the filename stem (`server/__tests__/migrationsSeed.test.ts`),
  and the number is apply order. Ids sort as strings, so keep the width.
- **Re-run `pnpm generate:sql` afterwards**, or a fresh install runs the
  migration against a table that never needed it. Same test catches it.
- Forward-only. Fixing a bad migration is a new migration; a `down` for a
  narrowed varchar cannot be written honestly.
- `import type { Migration }` — a value import closes a runtime cycle.
- Nothing but migrations and the generated `index.ts` lives in that directory.

## Never read another resource's tables

Bank transactions, character data — go through that resource's **exports**,
behind a `*Bridge` in `server/lib/`. Querying their tables couples micaOS to a
schema it does not own and can read stale data.

The bridge also **normalizes**, because these resources disagree silently:
Renewed-Banking stores `amount` as a positive magnitude with the direction in
`trans_type`, so anything inferring direction from a negative amount renders
every withdrawal as a credit. Normalize onto the `shared/types.ts` shape at the
boundary, keep the mapping in an exported pure function so it is testable, and
make the mock emit the **same** normalized shape — otherwise `pnpm dev`
disagrees with production and hides the bug.

## Done

New or changed server logic **gets a test** in `server/__tests__/` — server code
is excluded from `tsc`, so tests are the only thing standing behind it. Then
`pnpm verify` (AGENTS.md §9). Nothing here is exercised against a real database
by any suite; say so.
