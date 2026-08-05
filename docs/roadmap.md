# Roadmap

> **Local working file. Untracked on purpose** — it records unshipped intent, which is the thing that
> should not read as a promise in a public repo. Nothing in the committed tree links here.

What exists, what is proposed but unbuilt, the app ideas after that, and what the platform owes each
of them. Every statement here describes the code as it is today; a proposal is only ever under a
heading that says so.

This file exists because the Store's catalogue used to carry four app ideas as **installable
manifests with no code behind them** — Blabber, Crypto Tracker, Downtown Taxi and Marketplace,
complete with invented studios and version numbers. Tapping any of them opened a screen apologising
for itself. An idea recorded in a document is honest; the same idea rendered as an Install button is
not, which is the whole reason they moved here.

The detailed phase plan for Blabber's next iteration lives in `BLABBER-TODO.md`, also local. It is
kept separate deliberately: this file describes what is true, that one describes what is intended,
and merging them produced a document whose later sections contradicted its earlier ones.

---

## Shipped

### Blabber — short public posts

The first genuinely `core: false` app: the add-on path and the Store both have a real consumer rather
than a placeholder. `server/services/Blabber.ts` and `BlabberDms.ts`;
[`AGENTS.md` §10](../AGENTS.md) uses it as the worked example of a public read.

- **Feed and profiles.** Public feed on keyset paging, plus a per-account profile split into Blabs
  and Replies — a custom action, because the two tabs are `reply_to IS NULL` and `IS NOT NULL` and
  the generic filter only does equality.
- **Replies, and mouths.** A **mouth** is a repeat; with a body of its own it is a quote. Both are
  self-references on the Blab table rather than tables of their own, so they inherit the paging, the
  edit window and the moderation predicate for free.
- **Likes**, in `gphone_blabber_likes`, unique per account per Blab in the database rather than by
  find-then-insert, and counted in one batched `engagement` read rather than three queries per row.
- **Mentions.** `@handle` tokenized by `shared/richText.ts` — the same tokenizer the UI renders with,
  because two definitions of "what counts as a mention" is how you get one that highlights and never
  notifies. Fan-out is deduplicated by owner and drops self-mentions.
- **Direct messages**, strictly one-to-one by construction: two account columns and no participants
  table, so there is no shape a third person could be added to.
- **Editing.** 15 minutes by default, `gphone_blabber_edit_window` per server, enforced by a
  predicate in the `UPDATE` rather than a check before it. Delete stays available forever.

**Identity is one shared `gphone_accounts` table** with `app` as a column, not a table per app: a
handle, display name, avatar and bio are the same four fields for every social app, so an
Instagram-alike would have wanted a second table of identical shape. A player may hold **several**
accounts per app and switch between them, which is what forced `ColumnDef.private` and the automatic
withholding of `citizenid` from every public projection — a public read carrying the owner's
citizenid would correlate two deliberately-separate identities back to one person.

---

## Proposed, not built

Nothing in this section exists in the code. Each is a rename or a table that would need a
hand-written migration, which is why it is recorded rather than done quietly.

### `gphone_photos` → `gphone_media`

The photos table is `gphone_photos` today and holds one base64 `image` column. The proposal is to
rename it to `gphone_media` via the `table:` override on the `photos` service — **the service and app
id would stay `photos`**, so event names, `?app=photos` deep links, the `gphone:photos:` storage
namespace, `usePhotos` and the launcher label are all untouched — and to replace the single column
with `kind` + nullable `data` (base64) + nullable `url`, plus dimensions, duration and `alt_text`.

Two reasons it is not a quick change:

- **`SchemaMigrator` is additive-only** (AGENTS.md §8). A rename, a type change, and widening an
  enum are each printed for a human and never applied, so this needs a hand-written migration, and
  an existing install that skips it loses its gallery.
- **Base64 will not carry video.** `image` is `mediumtext`; a video or voice clip at that size will
  not survive crossing NUI. That is the actual motivation — the rename is a consequence of needing
  more than one storage shape, not a tidying exercise.

It would touch `server/lib/moderation.ts` (`REPORTABLE.gphone_photos`), `ReportDialog.svelte`'s
`targetTable` union, the FK in `Messages.ts`, `MessageRepository.ts`'s join, and the audit and report
tests.

### Other unbuilt proposals

Recorded here so they are not mistaken for existing behaviour; the reasoning is in
`BLABBER-TODO.md`.

- **Like → Ear.** Renaming the public-feed affordance so it pairs with Mouth — one speaks, one
  listens. Touches the table, the routes, the `BlabEngagement` fields and the UI copy, and route
  renames must land in all three layers plus the mock or the feature silently no-ops (§8).
- **A follow graph** (`gphone_account_follows`) and a Following feed.
- **A notifications table** (`gphone_blabber_notifications`), replacing the in-memory
  `unreadMentions` counter, which resets on resource restart and can only count what arrived while
  subscribed.
- **Hashtag storage and search.** `tokenizeRichText` already emits a `tag` token and renders it
  inert; there is no tag table, so there is nothing to aggregate a trending list from.
- **Report and block for social surfaces.** `REPORTABLE` lists only messages and photos, so a Blab,
  a DM and an account cannot currently be reported at all.

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

- **Blocked on:** a location capability. `location` is the other decorative permission — the only
  `GetEntityCoords` call in the tree drives the phone prop animation, and nothing is exposed to apps.
- **Payment is available** (item 5): `FrameworkPlayer.addMoney` exists and `server/lib/Payments.ts`
  has `transfer`. One restriction — **both players must be online**, because crediting an offline
  player would mean writing the framework's own `players` table. A driver paid at drop-off is online
  by definition, so this app is unaffected.
- **The push channel it needs is available** (item 2) — "a driver accepted" is the entire product,
  and `useAppEvents` delivers it. The recipient must be online: nothing is queued, which is correct
  here, since a rider who logged off is not taking the ride.
- **Membership-scoped rows are available** (item 1). A ride has exactly two parties and cannot grow,
  so the two-column shape Blabber's DMs use fits better than `access.membership` and a join table.

### Marketplace — peer-to-peer listings

List an item, browse, make an offer, buy.

- **Partly unblocked** (item 5): `transfer` can pay a seller, but it refuses an offline recipient,
  and a sale to a seller who logged off is the case that matters. The fix is a gPhone-owned
  pending-payments table flushed on `playerLoaded` — a mailbox, legitimate here because the money
  would sit in _our_ ledger rather than being pretended into the framework's. Not built ahead of the
  app that needs it.
- **Not blocked on the platform** (items 1 and 2): membership-scoped rows for an offer thread and
  public-read-with-paging for the listing index both exist, and Blabber has exercised them. What
  remains is this app's own work plus the offline-payment gap above.
- Push for "your listing sold" is available — a known, small recipient set, which is exactly what
  that channel is for.
- `ox_inventory` integration for handing over the item. Note
  `FrameworkBridge.removeInventoryItem` deliberately **fails open** — it returns `true` when no
  inventory resource is present — which is survivable for a consumable and is not survivable for a
  trade.

---

## Platform capabilities, and where each stands

Referenced by number from the ideas above.

1. **Multiplayer authorization in `defineService`** — built. Read/write axes, declared membership,
   `read: 'public'`, and keyset paging on `id DESC`, which `defineService` **requires** for a public
   read and throws without: `findAll` has no per-player bound once the ownership predicate is gone,
   so an unpaged public read is the whole table.
2. **A generic server→app push channel** — built. `appEventChannel(appId).push` / `pushMany` on the
   server, one net event, and a single generic `appEvent` route in `shell/nuiMessages.ts` that
   dispatches by app id, so an add-on joins it without touching the route table. Apps subscribe with
   `useAppEvents`. At-most-once and best-effort across sessions: nothing is queued, because the row
   is already written and an offline player gets it from the ordinary fetch.
3. **A shared player directory and social identity** — built. `server/lib/PlayerDirectory.ts`
   resolves a citizenid or phone number to a display name, online or offline, and absorbed the fork
   `Conversations.ts` had been carrying. Handles and avatars live in the shared `gphone_accounts`
   table, so anything social can claim a handle without new schema.
4. **Abuse controls at the `ServiceEndpoint` chokepoint** — built. Rate limit at the transport
   boundary, and per-column validation derived from the schema.
5. **An economy primitive** — built. `addMoney` on both framework paths, failing closed, and
   `transfer` with a compensating refund and a `PaymentOutcome` union that cannot be mistaken for
   success. Best-effort, not ACID: there is no transaction spanning another resource's money system.
   Offline recipients are refused rather than dropped.

**`location` and `network` are permissions with no capability behind them.** An app can declare
either and nothing changes, because there is no hook, endpoint or client surface to grant.
