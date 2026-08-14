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

Two constraints shape anything schema-shaped below:

- **A new table costs nothing; changing an existing one costs a migration.** Declare it, run
  `pnpm generate:sql`, import the file. `SchemaMigrator` still refuses to infer a rename, a retype or
  a widened enum from a diff and prints those for a human — but they are no longer a dead end, since a
  versioned migration file covers exactly that case (AGENTS.md §8, "Schema changes"). An enum value
  added later costs one migration file and an operator running `gphoneschema apply`, not data.
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
