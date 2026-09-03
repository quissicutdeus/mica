# Why the repo is laid out this way

The table below is the reference — every directory, what it runs in, and what
belongs there. The rest of this page is why it looks the way it does, for when a
layout choice seems arbitrary enough to "fix."

[`AGENTS.md` §8](../AGENTS.md) carries the four words the structure is built out
of (**app**, **shell**, **service**, **SDK**), and each means exactly one thing;
read that before this.

## The directories

| Path                           | Runs in      | Notes                                                                                     |
| ------------------------------ | ------------ | ----------------------------------------------------------------------------------------- |
| `client/services/`             | FiveM client | The client half of each service — NUI callbacks, server pushes                            |
| `client/game/`                 | FiveM client | GTA world: camera, freelook, phone prop and animations                                    |
| `client/lib/`                  | FiveM client | `ServiceProxy` (NUI↔server relay), `FrameworkBridge`, `nui`                               |
| `server/services/`             | FiveM server | One file per service, named for the service, auto-indexed                                 |
| `server/lib/`                  | FiveM server | `ServiceEndpoint`, `defineService`, `Repository`, `Database`, `framework/`                |
| `server/repositories/`         | FiveM server | `SchemaRepository` subclasses — the joins the generic path cannot express                 |
| `server/migrations/`           | FiveM server | Forward-only versioned migrations; `index.ts` is generated                                |
| `gphone.sql`                   | generated    | The whole schema from `pnpm generate:sql`; imported by hand                               |
| `scripts/framework-schema.sql` | hand-written | The audit ledger, which has no `defineService` behind it                                  |
| `server/__tests__/`            | Vitest/node  | Excluded from `tsc`; see AGENTS.md §1                                                     |
| `shared/types.ts`              | both         | `@shared/types` path alias, not a workspace package (AGENTS.md §3)                        |
| `shared/richText.ts`           | both         | One tokenizer for `@handle` — the UI renders and the server notifies from it              |
| `web/src/shell/`               | CEF+browser  | The OS: `Shell.svelte`, `PhoneFrame`/`TabletFrame`, `Launcher`, `ToastHost`               |
| `web/src/shell/frame/`         | CEF+browser  | What both frames share: status bar, home indicator, their gestures                        |
| `web/src/shell/state/`         | CEF+browser  | State the phone itself owns: navigation, keybinds, hardware, size                         |
| `web/src/services/`            | CEF+browser  | Client-side cache of each server service. Reached via the SDK                             |
| `sdk/`                         | CEF+browser  | `@gphone/sdk` — the public surface for apps (AGENTS.md §2.7)                              |
| `sdk/ui/`                      | CEF+browser  | UI primitives and icons apps may build with                                               |
| `web/src/apps/`                | CEF+browser  | One dir per app: `manifest.ts` + `index.svelte` + `Icon.svelte`, `tablet.svelte` optional |
| `web/src/nui/`                 | CEF+browser  | The bridge: transport, `fetchNui`, `useNuiEvent`, browser mocks                           |
| `web/src/lib/`                 | CEF+browser  | Helpers with no gPhone state and no I/O — formatters, markdown                            |

Seven `index.ts` files in that tree are **generated** by
`scripts/generate-barrels.js` — `client/services/`, `client/game/`,
`server/services/`, `server/migrations/`, `sdk/host/`, `sdk/kit/`, and
`sdk/icons.ts`. Add a file to the directory; do not edit the index. They are
committed, and `pnpm verify` regenerates them as its first step, so a hand-added
hook is picked up without a build — the generator used to run only inside
`build` and `watch`, both of which come _after_ the typecheck gate.

The migrations barrel is the odd member: an ordered **array** rather than
re-exports, because the runner iterates it in apply order and a module imported
for its side effects would give it nothing to iterate.

**`client/` splits by what a file talks to.** `client/services/` is the client
half of a service and speaks NUI and net events; `client/game/` speaks to GTA
and knows nothing about the phone's data. They were one `systems/` directory,
itself a rename of `controllers/` — and renaming it did not fix the thing wrong
with it, which was that two unrelated kinds of file shared a name that described
neither.

**`services/` appears on two sides on purpose.** `server/services/Notes.ts` and
`web/src/services/notes.ts` are the two ends of the one `notes` service, so they
carry the same name deliberately — it is not a collision to tidy up.

**A core service's store lives outside `apps/`, not inside the app that uses
it.** A tempting alternative is to move each store into the app that uses it
(`apps/notes/store.ts`), and for a core service it does not work: `contacts` is
read by Contacts, Messages and Phone, and `photos` by four apps. A store inside
one app's directory is a boundary violation (AGENTS.md §2.7) for every other app
that needs it. Core services are shared by nature; apps are not.

**An add-on is the deliberate exception, and its store lives beside it.** Notes,
Blabber and Hodlr each keep a `store.ts` inside `web/src/apps/<id>/`, because an
add-on ships as one self-contained bundle — a store of its own sitting in core
`web/src/services/` would be a piece of the app that the app cannot carry with
it. The test is ownership, not location: if exactly one app reads it and that
app is `core: false`, it belongs in the app directory.

Snek is `core: false` and has no `store.ts`, which is not a counter-example: its
leaderboard is `web/src/services/highscores.ts`, a core service any app may post
a score to, so it lives where a shared thing lives. Marketplace is the mirror
image — `core: true` with its store in `web/src/services/marketplace.ts`,
exactly where the rule puts it.

**Casing in `server/lib/` is a rule, not an accident.** PascalCase is a class or
a singleton object (`Repository`, `ServiceEndpoint`, `Database`,
`SchemaMigrator`); camelCase is a module of plain functions (`defineService`,
`migrate`, `schemaSql`, `moderation`, `seed`, `shell`, `payload`, `services`).
The filename tells you which you are importing.

**Why `web/src/services/` and not a store inside each app.** Every one of these
is read by more than its own app — Messages resolves names through `contacts`,
the shell raises a toast from `mail`. They are not app state; they are the
client half of a service, which is why they sit beside the SDK hooks that expose
them rather than inside `apps/`.
