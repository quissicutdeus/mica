# Roadmap

> **Tracked and pushed.** It records unshipped intent, which is the thing that must not read as a
> promise in a public repo — so write it as something a stranger will read, because a stranger can.
> No document links here: `README.md` and `AGENTS.md` had their roadmap links removed deliberately,
> which keeps unshipped intent reachable but never advertised. The one place in the committed tree
> that names this path is a comment in `web/src/apps/store/appInfo.ts`, recording where the Store's
> four invented add-ons went.

A pure backlog: what is proposed but unbuilt, and the app ideas after that. Nothing here describes
code that exists — the code and `AGENTS.md` are that record. When an entry ships, it leaves this file
rather than staying behind as a "done" essay; git history is where the reasoning behind a shipped
decision still lives. This file only ever tracks what is still ahead.

This file exists because the Store's catalog used to carry four app ideas as **installable
manifests with no code behind them** — Blabber, Crypto Tracker, Downtown Taxi and Marketplace,
complete with invented studios and version numbers. Tapping any of them opened a screen apologising
for itself. An idea recorded in a document is honest; the same idea rendered as an Install button is
not, which is the whole reason they moved here. Blabber has since shipped and its entry left this
file with it; the other three are still ideas, below.

---

## Proposed, not built

Nothing in this section exists in the code. The reasoning sits beside each item rather than in a
companion planning file: a proposal whose justification lives somewhere else is one nobody can
evaluate, and the somewhere else goes missing.

Two constraints shape every schema item below:

- **`SchemaMigrator` is additive-only** (AGENTS.md §8). A **new** table costs nothing extra — declare
  it, run `pnpm generate:sql`, apply the file by hand; there is no runtime DDL. A **rename** or a type
  change, _including widening an enum_, is printed for a human and never applied, so it needs a
  hand-written migration and an existing install that skips one loses data. Anything enum-shaped has
  to be over-provisioned now, because every value added later costs another migration.
- **Base64 will not carry video.** `gphone_media.data` is `mediumtext` holding base64; a video or
  voice clip at that size will not survive crossing NUI.

### Isolating remote/Store-installed add-ons

Today `loadRemoteApp` (`web/src/shell/state/registry.ts`) dynamic-imports a fetched bundle
directly into the shell's own JS context — no isolation of any kind. `docs/security.md` already
states this plainly: `permissions` on a manifest is a disclosure, not a sandbox, because every app
shares the shell's context and any check made there is one an add-on can route around. That is the
correct description of what exists today, not a gap in it — the platform has never claimed to run
untrusted code safely.

It stops being merely honest and starts being a real hole the day a remote add-on is something a
player installs from an author gPhone did not vet — a genuine third-party distribution channel
rather than a bundled add-on shipped in-tree. At that point the shell's own `localStorage`, its
stores, and every NUI callback a malicious bundle can reach become fair game for anything it loads.

Two candidate approaches, not designed further here: an `<iframe>` boundary with postMessage
relaying the SDK surface across it, or a Web Worker running the add-on off the DOM entirely with
the same relay. Either is a real architectural change — a new transport layer between an add-on and
`@gphone/sdk` — not a small patch, and not worth building until remote distribution is a real
channel rather than a capability sitting unused.

### Versioned migrations for breaking schema changes

Today `SchemaMigrator` (`server/lib/migrate.ts`, `server/lib/SchemaMigrator.ts`) is additive-only and
report-only. It already diffs `information_schema` against every `defineService` declaration and
correctly separates what is safe to infer (a missing column, a missing index — real, generated
`ALTER TABLE` SQL) from what is not (a type mismatch, an undeclared column), which it calls `drift`
and leaves alone. Nothing applies either half today: `server/services/Schema.ts` only ever calls
`SchemaMigrator.report()`, because `gphone.sql` is generated whole and importing it _is_ the schema —
a database that disagrees has not drifted, it has not been imported. That reasoning stops holding the
day a real server has player data it cannot wipe and reimport, which is the day this proposal is for.

**Versioned migration files, not a smarter planner.** A rename, a retype, an enum widened or a drop is
never inferable from a diff — `migrate.ts`'s own comment already says so, and it is right: a renamed
column is indistinguishable from one dropped and another added. `defineService` stays purely
declarative, describing only the schema's current shape, exactly as it does today. `server/migrations/`
gets one file per breaking change, numbered for order (`0001_rename_photos_to_media.ts`), each
exporting:

```ts
export interface Migration {
  id: string; // filename stem, and the ledger key
  description: string; // one line, for the boot-time report
  up: () => Promise<void>;
}
```

`up` calls `Database.query` directly, the same convention as the rest of `server/lib`. Forward-only,
deliberately: fixing a bad migration is a new forward migration, not a reversed old one, and a `down`
for a narrowed varchar or a dropped column usually cannot be written honestly anyway. TypeScript
rather than raw `.sql`, both because `server/` is typechecked (unlike `server/__tests__`) and because
this codebase already moved away from hand-written per-app SQL files once — the old `sql/apps/` — in
favor of declarations that generate SQL. A directory of hand-written `.sql` migrations would be a step
back toward exactly that.

**MySQL DDL is not transactional, and the design does not pretend otherwise.** `ALTER TABLE` and
`RENAME TABLE` each auto-commit in InnoDB regardless of any surrounding transaction, so a migration
with three statements is not all-or-nothing the way a row-data transaction is. The runner records a
migration as applied — one `INSERT` into a new `gphone_schema_migrations` ledger table (`id`,
`applied_at`) — only after `up()` returns without throwing. If it throws partway, the runner stops
immediately rather than continuing to the next migration: retrying blind could re-run a statement that
already succeeded before the one that failed.

**A fresh install must never run inherited migrations.** Today's `gphone.sql` already declares
`gphone_media`, not `gphone_photos` — if a brand-new install's ledger started empty, the runner would
try `0001_rename_photos_to_media` against a table that was never called that on this install, and fail
immediately. `pnpm generate:sql` closes this the way Rails' `schema.rb` does: it also scans
`server/migrations/` and has `gphone.sql` (and `dev-reset.sql`) pre-seed the ledger with every
migration id that exists as of that generation, via `INSERT IGNORE`. A fresh install's ledger says
"already applied" for all of history without ever running `up()`; only a database genuinely upgrading
from an older `gphone.sql` has gaps for the runner to fill. `server/__tests__` gets a structural test
in the shape of `routes.test.ts`: every file in `server/migrations/` must appear in the generated seed
`INSERT`, so the generator cannot drift from the directory the way `shared/routes.ts` used to drift
from `fetchNui` call sites.

**`gphoneschema apply`, console-only.** `server/services/Schema.ts` gains a subcommand — the same
shape `gphoneseed add`/`gphoneseed clear` already use — rather than a new top-level command.
`onResourceStart` keeps reporting and changes nothing, now also listing pending versioned migrations
by id alongside the existing additive/drift report. `apply` runs both halves in one pass: the additive
statements `SchemaMigrator.plan()` already generates, then any pending versioned migrations in order.
One command, because an operator thinks "bring my database up to date," not "apply the two kinds of
change separately." Gated on `source === 0` rather than `isAdmin` — the same trust tier
`docs/security.md` already draws around the console, and the one that can actually take a backup
first, which an in-game admin typically cannot.

**Deliberately out of scope for a first cut.** A `pnpm new:migration <description>` scaffold,
mirroring `scripts/new-app.js` — cheap to add later, easy to defer now. Rollback of any kind beyond
forward-only. Running a migration's SQL against real MySQL in the automated suite — out of reach the
same way every other DB-shaped thing in this codebase is (§8 already says so), and the runner's own
tests drive a mocked `Database`, the same convention every repository test already follows.

### Per-app signal degradation

`network` has been a declarable `AppPermission` since the enum was written, with no capability behind
it. `server/services/Signal.ts` already computes and pushes a real per-player bars value — a
city-wide level, dead zones, per-player overrides — evaluated on a two-second poll, so the state
exists and reaches the phone; nothing reads it. Every app behaves identically at four bars and at
zero. Closing the gap is per-app rather than platform work: Messages, Phone, Blabber, Store, Bank and
Mail each need a live connection and so need their own zero-bar path that degrades rather than
throws; Notes, Camera, Media, Calculator and Settings are local and should stay indifferent to it.

---

## Ideas, not yet started

### Crypto Tracker — prices and a portfolio

Live prices, a watchlist, a portfolio valuation.

- **Blocked on:** an outbound HTTP path. The `network` permission is **decorative** — there is no
  `PerformHttpRequest` anywhere in `server/` or `client/`, so an app cannot reach an external API at
  all. That capability has to exist before this app can be more than mock data.
- Alternatively, a server-side simulated market with no external dependency, which sidesteps the gap
  entirely and is arguably a better fit for a roleplay server.
- Per-player watchlists want per-character storage; `useStorage` is `localStorage`, so it is per-PC
  and shared between characters.

### Downtown Taxi — request a ride, pay the fare

A rider posts a request, a driver accepts, the fare moves at drop-off.

- **Blocked on:** a location capability, though less completely than before. Messages can now share
  the _caller's own_ position, server-authoritative and read on demand — but a taxi app needs the
  rider to see the _driver's_ live position en route, which is a different, unbuilt shape: a
  continuous or polled read of someone else's coordinates, not a one-shot self-share.
- **Payment is available:** `FrameworkPlayer.addMoney` exists and `server/lib/Payments.ts` has
  `transfer`. One restriction — **both players must be online**, because crediting an offline player
  would mean writing the framework's own `players` table. A driver paid at drop-off is online by
  definition, so this app is unaffected.
- **The push channel it needs is available** — "a driver accepted" is the entire product, and
  `useAppEvents` delivers it. The recipient must be online: nothing is queued, which is correct here,
  since a rider who logged off is not taking the ride.
- **Membership-scoped rows are available.** A ride has exactly two parties and cannot grow, so the
  two-column shape Blabber's DMs use fits better than `access.membership` and a join table.

### Marketplace — peer-to-peer listings

List an item, browse, make an offer, buy.

- **Partly unblocked:** `transfer` can pay a seller, but it refuses an offline recipient, and a sale
  to a seller who logged off is the case that matters. The fix is a gPhone-owned pending-payments
  table flushed on `playerLoaded` — a mailbox, legitimate here because the money would sit in _our_
  ledger rather than being pretended into the framework's. Not built ahead of the app that needs it.
- **Not blocked on the platform:** membership-scoped rows for an offer thread and
  public-read-with-paging for the listing index both exist, and Blabber has exercised them. What
  remains is this app's own work plus the offline-payment gap above.
- Push for "your listing sold" is available — a known, small recipient set, which is exactly what
  that channel is for.
- `ox_inventory` integration for handing over the item. Note
  `FrameworkBridge.removeInventoryItem` deliberately **fails open** — it returns `true` when no
  inventory resource is present — which is survivable for a consumable and is not survivable for a
  trade.
