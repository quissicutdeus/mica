# Why the repo is laid out this way

The directory table in [`AGENTS.md` §8](../AGENTS.md) is the reference; this is why it looks the
way it does, for when a layout choice seems arbitrary enough to "fix."

**`client/` splits by what a file talks to.** `client/services/` is the client half of a service
and speaks NUI and net events; `client/game/` speaks to GTA and knows nothing about the phone's
data. They were one `systems/` directory, itself a rename of `controllers/` — and renaming it did
not fix the thing wrong with it, which was that two unrelated kinds of file shared a name that
described neither.

**`services/` appears on two sides on purpose.** `server/services/Notes.ts` and
`web/src/services/notes.ts` are the two ends of the one `notes` service, so they carry the same
name deliberately — it is not a collision to tidy up.

**A core service's store lives outside `apps/`, not inside the app that uses it.** A tempting
alternative is to move each store into the app that uses it (`apps/notes/store.ts`), and for a
core service it does not work: `contacts` is read by Contacts, Messages and Phone, and `photos` by
four apps. A store inside one app's directory is a boundary violation (AGENTS.md §2.7) for every
other app that needs it. Core services are shared by nature; apps are not.

**An add-on is the deliberate exception, and its store lives beside it.** Notes, Blabber and Hodlr
each keep a `store.ts` inside `web/src/apps/<id>/`, because an add-on ships as one self-contained
bundle — a store of its own sitting in core `web/src/services/` would be a piece of the app that
the app cannot carry with it. The test is ownership, not location: if exactly one app reads it and
that app is `core: false`, it belongs in the app directory.

Snek is `core: false` and has no `store.ts`, which is not a counter-example: its leaderboard is
`web/src/services/highscores.ts`, a core service any app may post a score to, so it lives where a
shared thing lives. Marketplace is the mirror image — `core: true` with its store in
`web/src/services/marketplace.ts`, exactly where the rule puts it.

**Casing in `server/lib/` is a rule, not an accident.** PascalCase is a class or a singleton
object (`Repository`, `ServiceEndpoint`, `Database`, `SchemaMigrator`); camelCase is a module of
plain functions (`defineService`, `migrate`, `schemaSql`, `moderation`, `seed`, `shell`,
`payload`, `services`). The filename tells you which you are importing.

**Why `web/src/services/` and not a store inside each app.** Every one of these is read by more
than its own app — Messages resolves names through `contacts`, the shell raises a toast from
`mail`. They are not app state; they are the client half of a service, which is why they sit
beside the SDK hooks that expose them rather than inside `apps/`.
