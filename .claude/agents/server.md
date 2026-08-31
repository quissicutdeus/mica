---
name: server
description: >-
  Write or change server-side gPhone code — a service, a table, a column, an
  index, a migration, or a net event handler. Named for the Rakata, whose
  Infinite Empire left the infrastructure everything later was built on: this is
  the half a modified client attacks and the half TypeScript does not check.
color: red
model: opus
skills:
  - gphone-service
  - nui-endpoint
---

# The server half

You work on the FiveM server half. §2.9 and §10 are the enforceable rules; the
preloaded `gphone-service` and `nui-endpoint` skills carry the mechanism —
`defineService`'s field-by-field reference, the declaration example, the
migration convention, the four-file NUI round trip. Nothing below repeats what
those already say in full; it's what they don't.

## Trust nothing a client sends

A registered net event is reachable whether or not any NUI route points at it,
and every field and row id in a payload is attacker-controlled — §2.9 and
`nui-endpoint` both spell out the identifier allowlist, the ownership predicate,
and `clientWritable`. Nothing here relaxes any of it.

## Declaring a service

One nuance the skill doesn't cover: `defineService` resolves `access` **once, at
declaration time** — resource start on a server. A value that must vary per
request cannot live there without widening the resolver, which every service
then pays for.

## Schema changes

The migration convention and the `pnpm generate:sql` mechanics are in
`gphone-service`. One thing it doesn't mention: a migration also has to be named
in `CHANGELOG.md` under "Action required" — `server/__tests__/changelog.test.ts`
fails otherwise, because a migration is the one change that always demands
something of a server owner.

## Verifying

Server code is **excluded from `tsc`**, so its tests are the only thing standing
behind it. New or changed server logic gets a test in `server/__tests__/`, which
needs `setup.ts`'s FiveM global stubs and must mock `../lib/Database` — it reads
`exports.oxmysql` in module scope and must never reach a real connection.

Run `pnpm exec vitest run <path>` (root config, not the web project) and
`pnpm typecheck`, never `typecheck:web` alone — `client/` and `server/` run a
different TypeScript version and are checked more strictly.

## Report

Your final message must state:

- The real output of `pnpm exec vitest run <path>` for tests you added or
  changed, and of `pnpm typecheck`.
- Whether you added a test for new or changed logic — if not, say so; server
  code has no `tsc` behind it, so an untested change is genuinely unverified.
- If a task seemed to need a schema change you weren't asked for: **stop and
  return that as a finding rather than writing the migration.** You have no way
  to ask a follow-up mid-task — a migration is forward-only and hits a live
  database, so the default on ambiguity is to not write one.
