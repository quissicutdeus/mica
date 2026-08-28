---
name: rakata
description:
  Write or change server-side gPhone code — a service, a table, a column, an
  index, a migration, or a net event handler. Named for the Rakata, whose
  Infinite Empire left the infrastructure everything later was built on: this is
  the half a modified client attacks and the half TypeScript does not check.
---

# The server half

You work on the FiveM server half. Read `AGENTS.md` in full before your first
edit, and read `.claude/skills/gphone-service/SKILL.md` — it pulls in
`docs/schema-and-services.md`, which is the field-by-field reference.

## Trust nothing a client sends

A registered net event is reachable whether or not any NUI route points at it: a
modified client emits `gphone:server:<service>:<action>` directly. Every field
and row id in a payload is attacker-controlled.

- **Never interpolate a payload key into SQL.** MySQL cannot parameterize an
  identifier, so keys are checked against the repository's `columns` allowlist.
- **Never mutate a row without an ownership predicate.** A row id alone is never
  authorization. For shared rows, check membership via `Repository.isMember`.
  Privileged writes go through a named repository method built on
  `updateUnscoped`, never a service-level bypass.
- `clientWritable` declares what a payload may set. `id`, `citizenid`,
  `created_at`, `updated_at` and `status` are never client-writable.
- `assertWritableValue`'s messages reach players as toasts, so they carry no
  `[Repository]` prefix and no table name.

Do not register a generic action the app does not use —
`server/__tests__/reachability.test.ts` keeps that honest.

## Declaring a service

A service is declared once via `server/lib/defineService.ts`, which derives the
repository, the write allowlist, the CRUD events and the DDL from one schema.
`id, citizenid, status, created_at, updated_at` are supplied by the framework —
declaring one is an error. `access` is two axes, `read` and `write`;
`read: 'public'` **requires** `paging` and throws without it. `'members'` and
`'public'` reads register no generic `get`. `access.editWindow` time-boxes an
ownership-scoped update only, never a delete.

Note that `defineService` resolves `access` **once, at declaration time** —
resource start on a server. A value that must vary per request cannot live there
without widening the resolver, which every service then pays for.

## Schema changes

A schema change is written once, in the declaration, then `pnpm generate:sql`
regenerates the committed `gphone.sql`. A live database is brought up by
`gphoneschema apply` from the server console — the only thing in this resource
that changes a live schema.

A rename, retype, widened enum or drop needs a **versioned migration** in
`server/migrations/`, named `NNNN_snake_case_description.ts`, forward-only.
Re-run `pnpm generate:sql` after adding one. A migration also has to be named in
`CHANGELOG.md` under "Action required" — `server/__tests__/changelog.test.ts`
fails otherwise, because a migration is the one change that always demands
something of a server owner.

**If a task seems to need a schema change you were not asked for, stop and say
so rather than writing the migration.**

## Verifying

Server code is **excluded from `tsc`**, so its tests are the only thing standing
behind it. New or changed server logic gets a test in `server/__tests__/`, which
needs `setup.ts`'s FiveM global stubs and must mock `../lib/Database` — it reads
`exports.oxmysql` in module scope and must never reach a real connection.

Run `pnpm exec vitest run <path>` (root config, not the web project) and
`pnpm typecheck`, never `typecheck:web` alone — `client/` and `server/` run a
different TypeScript version and are checked more strictly.

Every net event is `gphone:<side>:<app>:<action>`, enforced by
`server/__tests__/eventNames.test.ts`. A NUI round trip touches three layers and
fails silently in game if one is missing.
