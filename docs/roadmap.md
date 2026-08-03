# Roadmap

App ideas worth building, and what the platform still owes each of them.

This file exists because the Store's catalogue used to carry four of these as **installable
manifests with no code behind them** — Blabber, Crypto Tracker, Downtown Taxi and
Marketplace, complete with invented studios and version numbers. Tapping any of them opened a
screen apologising for itself. An idea recorded in a document is honest; the same idea
rendered as an Install button is not, which is the whole reason they moved here.

Nothing in this file is a commitment, and nothing here is installable.

---

## In progress

### Blabber — short public posts

The Twitter clone, and the first **real non-core app**: the thing that will finally exercise
the add-on path end to end, which has never had a genuine consumer.

- **Shape.** Public feed, `@handle` per player, short posts, replies, likes.
- **Editing.** An author can fix a typo for a few minutes after posting, then the post
  freezes. Configurable per server; not a rewrite window.
- **Icon.** A megaphone — stroke-only, matching the house style.
- **Blocked on:** public-read / owner-write services with keyset paging (platform item 1);
  a player directory so an `@handle` resolves for someone who is not in your contacts
  (item 3). Replies want the server→app push channel (item 2), though the app is usable
  without it.

---

## Ideas, not yet started

### Crypto Tracker — prices and a portfolio

Live prices, a watchlist, a portfolio valuation.

- **Blocked on:** an outbound HTTP path. The `network` permission is currently
  **decorative** — there is no `PerformHttpRequest` anywhere in `server/` or `client/`, so an
  app cannot reach an external API at all. That capability has to exist before this app can
  be more than mock data.
- Alternatively, a server-side simulated market with no external dependency, which sidesteps
  the gap entirely and is arguably a better fit for a roleplay server.
- Per-player watchlists want per-character storage; today `useStorage` is `localStorage`, so
  it is per-PC and shared between characters.

### Downtown Taxi — request a ride, pay the fare

A rider posts a request, a driver accepts, the fare moves at drop-off.

- **Blocked on:** a location capability. `location` is the other decorative permission — the
  only `GetEntityCoords` call in the tree drives the phone prop animation, and nothing is
  exposed to apps.
- **Payment is available now** (item 5): `FrameworkPlayer.addMoney` exists and
  `server/lib/Payments.ts` has `transfer`. One restriction — **both players must be online**,
  because crediting an offline player would mean writing the framework's own `players` table.
  A driver paid at drop-off is online by definition, so this app is unaffected.
- Wants the push channel (item 2) badly: "a driver accepted" is the entire product.
- Membership-scoped rows (item 1) for the rider + driver pair.

### Marketplace — peer-to-peer listings

List an item, browse, make an offer, buy.

- **Partly unblocked** (item 5): `transfer` can pay a seller. But it refuses an offline
  recipient, and a marketplace sale to a seller who logged off is the case that matters. The
  fix is a gPhone-owned pending-payments table flushed on `playerLoaded` — a mailbox, which is
  legitimate here because the money would sit in _our_ ledger rather than being pretended into
  the framework's. Not built ahead of the app that needs it.
- **Blocked on:** membership-scoped rows for an offer thread between buyer and seller
  (item 1), and public-read for the listing index.
- Wants push (item 2) for "your listing sold" — a known, small recipient set, which is
  exactly what that channel is for.
- `ox_inventory` integration for actually handing over the item. Note
  `FrameworkBridge.removeInventoryItem` deliberately **fails open** — it returns `true` when
  no inventory resource is present — which is survivable for a consumable and is not
  survivable for a trade.

---

## The platform work these depend on

Tracked separately; summarised here so the dependencies above resolve to something.

1. **Multiplayer authorization in `defineService`** — public-read and membership-scoped
   services, plus keyset paging. The read/write axes and declared membership have landed;
   what remains is `read: 'public'` and paging, which is what a feed needs.
2. **A generic server→app push channel** — `shell/nuiMessages.ts` is a closed route table
   that an add-on cannot join.
3. **A shared player directory** — resolving a citizenid to a display name, handle and
   avatar, including for offline players.
4. **Abuse controls at the `ServiceEndpoint` chokepoint** — done. Rate limit at the transport
   boundary, and per-column validation derived from the schema.
5. **An economy primitive** — done. `addMoney` on both framework paths, failing closed, and
   `transfer` with a compensating refund and a `PaymentOutcome` union that cannot be mistaken
   for success. Best-effort, not ACID: there is no transaction spanning another resource's
   money system. Offline recipients are refused rather than dropped.

Also decorative and worth knowing about: **`location` and `network` are permissions with no
capability behind them.** An app can declare either and nothing changes, because there is no
hook, endpoint or client surface to grant.
