# Roadmap

> **Tracked and pushed.** It records unshipped intent, which is the thing that must not read as a
> promise in a public repo — so write it as something a stranger will read, because a stranger can.
> No document links here: `README.md` and `AGENTS.md` had their roadmap links removed deliberately,
> which keeps unshipped intent reachable but never advertised. The one place in the committed tree
> that names this path is a comment in `web/src/apps/store/appInfo.ts`, recording where the Store's
> four invented add-ons went.

What exists, what is proposed but unbuilt, the app ideas after that, and what the platform owes each
of them.

**Every statement here describes the code as it is today; a proposal is only ever under a heading
that says so.** That rule is the structure of the file rather than a style note, and it is the one
thing not to relax. Description and intent were merged once, and it went badly: a section describing
what existed asserted a fact a later section renamed, so the document undid itself as you read down.
The failure mode is not an inaccurate line — it is a reader who cannot tell which half they are in.
So the reasoning behind an unbuilt thing belongs under its own proposal heading here, not in a second
document that this one defers to and a reader may not have.

This file exists because the Store's catalog used to carry four app ideas as **installable
manifests with no code behind them** — Blabber, Crypto Tracker, Downtown Taxi and Marketplace,
complete with invented studios and version numbers. Tapping any of them opened a screen apologising
for itself. An idea recorded in a document is honest; the same idea rendered as an Install button is
not, which is the whole reason they moved here. Blabber has since been built and is a real Store
listing; the other three are still ideas, further down.

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

#### Author hydration, and the bug the mock hid

`Blab.handle`, `display_name` and `avatar` are hydrated for display, and for a while nothing joined
`gphone_accounts` to supply them — only `create`'s echo carried a handle, so a feed, a profile and a
quote card each rendered a blank author **in game only**. Every fixture in
`web/src/nui/mocks/registry.ts` embedded a handle, so the feed looked correct in `pnpm dev` and
Playwright stayed green throughout. That is the reusable lesson rather than a footnote: a mock that
over-provides hides exactly the layer it stands in for.

`server/repositories/BlabberRepository.ts` overrides `findAll` and exposes `hydrate` and
`findPublicById`, batching the join for a whole page as `MessageRepository` already did for
attachments. Three consumers go through it — the generic public read, `blabber:profile`, and
`create`'s echo of a mouth — so the two feeds cannot disagree. Two queries per page regardless of
page length, with quoted rows' authors fetched alongside the page's own, since a quote is usually
somebody else's. The join **never** selects the author's `citizenid`: re-adding it through a join
would defeat the alt-privacy property `publicColumns` exists for. `server/__tests__/blabber.test.ts`
is what stands behind it, including that neither query returns an author citizenid, that a missing
quote target resolves to `null` rather than a stale card, and that a vanished account leaves the page
standing.

**One level of mouthing.** A quote of a quote renders its immediate target and no further, because
`BlabRow` paints one nested card and a deeper walk would fetch rows nothing shows.

This is the one shipped item that still wants in-game eyes, and for the same reason it was missed:
Playwright being green says nothing about it. Against a real database, confirm a feed, a profile, a
thread and a quote card each render an author.

#### Two composers, deliberately not one

The DM thread reused the post `Composer` with a `placeholder`, so its send button read "Post", a
280-character counter sat over a `varchar(500)` column, and "Posting as @handle" appeared inside a
private conversation. `Composer.svelte` now keeps the public shape — text button, 280 counter,
"Posting as @x" — and `DmComposer.svelte` mirrors Messages' icon-only send instead. The two are
diverging rather than converging, which is the argument against parameterising one: a shared
component would force the public composer to carry the GIF and reaction affordances that are
explicitly ruled out for Blabs. `Composer`'s `placeholder` prop stays, because `Thread` and the edit
path both pass one and both are public.

The DM e2e spec had been **asserting the bug** — it clicked a button named `Post` — so it was green
_because_ the composer was wrong. Three smaller defects went with it: the `EmptyState` flashed before
the first page returned (now gated on `feed.loaded`, per AGENTS.md §11.6), the DM unread badge read 0
until a push arrived (`loadDmThreads` now runs on `onAppForeground`), and the active account reset to
the first one every session (`activeAccountId` is `usePersisted`).

#### Identity, and the composer as a FAB

The app was one screen with a permanently-expanded composer, a "Posting as @x" strip, an account
switcher and a text link to DMs. Identity is now a small avatar in the header opening a menu beneath
it, and the composer a FAB and a full-screen overlay reused for editing. `Screen`'s `actions` snippet
also carries the DM icon and its unread badge.

**The identity menu drops from the top, and that is a correction.** It was first built as a bottom
sheet copying `ReportDialog`, the repo's only one, and the borrowing was wrong: a sheet rises from the
bottom because a phone is tall and a thumb lives down there. gPhone is a mouse-driven overlay inside a
game, so that reasoning does not transfer, and a five-item menu opening a full screen-height away from
the control that triggered it is only travel. A dialog that wants the player's whole attention —
reporting content — still belongs at the bottom. The scrim is a real `<button>` rather than a dimmed
`div`, so the menu is dismissable by the gesture a menu is dismissed by and not only by Back.

**A Blab's avatar goes to the profile**, like the name beside it. It is a picture of a person sitting
next to a link to that person, and it did nothing when tapped — the one part of a row that looked like
a link and was not. Labelled for its destination rather than its contents, which also keeps it
distinct from the name button in the accessibility tree.

**Two features the server already allowed were unreachable from the phone**, and the sheet is what
reaches them:

- **A second handle.** `gphone_max_accounts_per_app` has always permitted three, while `ClaimHandle`
  rendered only when the account list was _empty_ — so accounts two and three could not be created at
  all. The cap now rides along with the account list rather than being copied into the client: it is a
  convar, and a hardcoded 3 goes wrong the first time an owner raises it. Same reasoning as
  `createBlab` echoing `editWindow`.
- **Editing a profile.** `display_name` and `bio` were client-writable columns with no UI and no
  route. `updateAccount` is the generic owner-scoped `accounts:update`, which is only safe to expose
  because `app` and `handle` are `clientWritable: false` — a renamed handle would break every mention
  already posted.

**No avatar picker, and it is blocked rather than skipped.** `gphone_accounts.avatar` is
`varchar(255)`; `PhotoPickerModal` hands back the base64 image rather than a reference, so wiring it
up produces a value the per-column length rule correctly refuses. It needs the column to hold a media
reference — the `gphone_media` work — and widening it is a type change `SchemaMigrator` will not
apply.

**The DM title is the peer**, not the literal `'Message'`, and resolved from the account already in
hand rather than from the inbox list — which is what makes **starting a DM from a profile** possible,
something the DM empty state has always promised and no code path implemented. A thread with a peer
not yet in the inbox used to title as `@` with a `?` avatar.

#### The follow graph, and a nav with somewhere to go

`gphone_account_follows` is a child table of the **accounts** service rather than Blabber's, because
it is account-to-account and accounts are shared — a future Instagram-alike inherits the graph instead
of growing a parallel one. Two account columns, `created_at`, a unique index over the pair, and a key
on the followee. **No `citizenid` column and none needed:** every account row carries an `app`, so a
row can only ever link two accounts in the same app, and ownership stays behind each account where a
reader cannot see it.

`follow`, `unfollow` and `follows` all call `ownedAccount` first — `follower_account_id` arrives in a
payload and a payload is not proof of intent (§2.9). `follow` is insert-only with the unique index
making it idempotent, so a duplicate is reported as success; `unfollow` is a `DELETE` scoped to the
caller's own account. Both refuse a self-follow, which would put your own posts in your Following feed
and inflate both counts for everybody, and refuse a followee in another app.

Counts are read from the graph rather than denormalised onto the account row — a `follower_count`
column is a second copy of a fact the table already holds, and it drifts the first time a follow is
removed by a path that forgets to decrement. `followedByMe` is about **one** of the viewer's accounts,
not all of them, because a main and an alt follow different people and the button acts as whichever is
active. That is the one place this differs from `engagement`, which answers across every account a
player holds.

**The Following feed is `IN (subquery)`, not a join.** A join emits one row per matching follow row, so
the feed would duplicate a post if the graph ever held a duplicate — which the unique index prevents,
but which the query should not depend on. It also keeps one table in the FROM, which is what lets the
projection name bare `publicColumns`. Top-level only, like the public feed. Client-side it is a second
`createPagedStore` with its own cursor: one shared store would mean one cursor walking two result sets,
so switching tabs would resume the other feed's position.

**The bottom nav landed with it, and that was the point of holding it back.** `TabBar` was written once
before Following existed and deleted unbuilt — `components.ts` says exactly that about `ActionSheet`,
and `pnpm deadcode` enforces it. It carries Feed and Following, not the four the end state wants,
because Search and Notifications have no server behind them. `FloatingActionButton` gained an opt-in
`raised` so it clears the bar they share the `overlay` snippet with, and a non-default tab is its own
back rung so Back returns to the feed rather than sending the player home.

#### The lists behind the counts

The counts above shipped deliberately inert, with a comment in `Profile.svelte` saying the screens
behind them did not exist — a count is a fact and a link to nothing is a promise. `followers` and
`following` on the **accounts** service are those screens, so the numbers are buttons now.

**Public, like the counts.** No `ownedAccount` check, and there must not be one: requiring ownership
would mean you could only see your own followers, which is not what the number on a stranger's
profile is counting. Every row is a public projection of `gphone_accounts`, so `citizenid` is withheld
exactly as it is on a Blab — a follower list is the one screen that would otherwise correlate every
alt in the graph back to its owner.

**Keyset paged on the follow row's own id, not the account's.** That is the only ordering a reader can
make sense of: most-recently-followed first. Account id order is "whoever signed up first", and a
`created_at` cursor is second-resolution, so the naive form silently drops a row wherever two follows
share a second. `gphone_account_follows` gained a `(follower_account_id, id)` index to make the
following direction a plain range scan — the unique index starts with the same column but InnoDB
appends the primary key after `followee_account_id`, so it yields followee order and the list would
have taken a filesort. The other direction needs no key: `followee_account_id` is non-unique, so its
appended primary key already makes it `(followee_account_id, id)`.

**A join here, where the Following _feed_ used `IN (subquery)`.** Not an inconsistency. There the
follows table was a filter over posts and a duplicate row would have duplicated a post; here it **is**
the list, one row per relation, so it belongs in the FROM with the account joined onto it.

**One rung, not two, and no Follow button on a row.** Both lists are the same depth, so two
predicates only one of which can ever be true would be a dead branch pretending to be a ladder — the
title says which list it is, the way Settings' panes do. A per-row Follow button would need this
viewer's follow state for all thirty rows, which is the round-trip storm the batched `engagement` read
exists to avoid; a row opens the profile, which already owns the button.

`pageBounds` moved from a local helper in `Blabber.ts` to `lib/payload.ts` on the way, since these
were its third and fourth call sites, and it now reads the numbers from the service's own `paging`
declaration rather than from two retyped constants.

#### The notifications tab, and the tab nobody could open

Blabber's third nav destination reads the OS notification shade filtered to `blabber`, through the
generic `useNotifications(appId)` — no per-app table, which is why an add-on can have this at all.
Mentions, follows and DMs already wrote rows through the push channel, so the tab is a reader of
something that was being persisted correctly the whole time.

**It shipped unreachable, and that is the part worth keeping.** `selectTab` narrowed with a ternary
— `next === 'following' ? 'following' : 'feed'` — so every id that was not `following` selected the
feed. The tab was rendered, routed, server-backed and impossible to open: tapping it read as a dead
button. Nothing caught it because no spec had ever tapped the third tab, and the two that existed
both passed. A destination present in the markup is not a destination a player can reach, and the
only thing that distinguishes them is a test that clicks it.

Three smaller things went with it. The back rung's title was hardcoded to `'Following'`, so the
Notifications tab announced itself as the other one. The tab fetched from an `$effect`, which §11.6
rules out — the parent loads on tab select, exactly as it does for Following. And the browser mock
held no `blabber` notification at all, so the tab could only ever have rendered its empty state in
`pnpm dev`; the row and its deep link went unexercised. That is the mirror of the author-hydration
lesson above — a mock that **under**-provides leaves a path untested just as effectively as one that
over-provides leaves it wrong.

**A deep link opened a blank post**, which the tab made visible rather than caused. A link names an
id and nothing else, so `index.svelte` opened a thread around a `{ id } as Blab` stub and `Thread`
rendered it directly: replies loaded above a post with no body, no author and no timestamp. Every
path that follows a mention hit it — the shade, the toast, and now this tab. The generic `get`
cannot answer "one row by id": `id` is framework-supplied and so never `clientFilterable`, and a
public read is paged rather than addressed. A `blabber:blab` action returns one row through the same
`findPublicById` the quote cards already use, so a deep-linked Blab and the same Blab in a feed
cannot disagree about its author, and `status = 'active'` keeps a link from outliving a moderated
post. A row that is genuinely gone answers `null` and the thread says so, because tapping a stale
notification is an ordinary thing to do.

**Unread counts were never loaded at boot.** `loadUnreadCounts` ran only when the shade or an
in-app notifications screen was opened, so a launcher badge fed from it counted only what arrived
over the push channel while the phone happened to be running — the persisted rows the notifications
table exists for reached the badge nowhere. It is in `bootstrapStores` now, beside the account and
the admin check: one query answering for every app, rather than something each `preload` repeats.
A badge has to be right before the launcher paints (§11.1).

#### Two things that made first-run unreachable

**Uninstalling a bundled add-on deleted a component that was still in the build.**
`shell/state/registry.ts` kept one `componentRegistry` for two different facts — what the glob found
in `apps/` at startup, and what has been registered since boot — and `unregisterApp` deleted from it.
So installing Blabber, uninstalling it and installing it again left the Store's
`getComponent(id) || placeholderComponent()` with nothing to find, and the icon opened **"Not part of
this build"** for an app whose code had never left the resource. In CEF the page never unloads, so it
stayed wrong for the rest of the session rather than until a refresh. The two maps are now separate and
`getComponent` falls back to the bundled one; a remote app's component is still forgotten on uninstall,
because that code really is gone. `registry.test.ts` pins the map and the e2e spec pins the path a
player walks.

**And the first-run screen could not be seen in the browser at all.** The mock fixture always held
accounts, so Blabber's claim gate — the only thing a new player sees — never rendered in `pnpm dev` or
under Playwright. `?state=fresh` presents the phone as never used, alongside the existing `?app=`
harness: `?app=blabber&state=fresh`. A path no developer can look at is a path that rots, and this one
is every player's first impression.

Two things about that flag are deliberate. It is **one axis rather than a list of app ids** — it began
as `?fresh=blabber`, which made the ordinary invocation repeat the id `?app=` had just named, buying
per-app independence nothing wanted. And it is **not the default for `?app=`**: opening an app to look
at a populated feed is what the harness is mostly for, and every other spec in `e2e/apps/` needs the
fixtures.

Worth being explicit about what first run _is_, since it is easy to assume there is more to it: install
from the Store, tap the icon, and the app asks for a handle — lowercase, 3–32 characters — with no feed
and no composer until one is claimed. Uninstalling does **not** surrender it: the account lives in
`gphone_accounts` keyed on citizenid, so reinstalling goes straight to the feed. Only the app's local
storage is cleared, which is where the active-account choice lives.

**The mock could not say no, and that hid two things.** `getMyAccounts` filtered by `app` alone, so
every account in the fixture came back as the player's: every profile rendered as your own, and the DM
fixture had @nightowl messaging an account it supposedly was. The fixture now records which accounts
the player owns, `createBlab` checks ownership rather than mere existence — its error message had been
claiming that check for a while — and the browser can therefore reach a profile that is somebody
else's.

Every overlay is its own `useAppLevels` rung, or Backspace skips it and sends the player home from
what looks like a modal (§2.7). The overlays are `inset-0` like `PhotoPickerModal`, so they paint over
the header: the arrow is hidden rather than broken, and the shell dispatches `back` regardless of what
is on top.

**Which makes an on-screen exit per overlay mandatory, not decorative.** With the header covered, an
overlay whose only way out is the keybind has no visible way out at all — and Claim shipped exactly
like that for a moment, since `ClaimHandle` had a Claim button and nothing else. Its `oncancel` is
optional for the reason `Composer`'s is: the same component is also the zero-account gate, where there
is nothing behind it to go back to and a Cancel would dismiss the only thing on screen. The other
three were already covered — the composer's Cancel, Edit profile's Cancel, and the menu's scrim, which
is a real button precisely so clicking away works.

#### Search, hashtags, and the flattened view a search result needed

The fourth tab now exists: `TabBar` carries Feed, Following, Notifications and Search, and every one
of those four opens. `Search.svelte` is a `SearchBar` over three segments — People, Blabs, Tags — plus
trending tags shown before anything is typed, each backed by a real server-side search rather than
`filterByQuery` over a partial in-memory list: `accounts:search`, `blabber:search` (body, including
replies) and `blabber:searchTags`/`byTag`/`trendingTags`. All of it paginated with the same keyset
cursor as every other public read (§10) — a search is a public read like any other, and `defineService`
throws for one without `paging`.

Hashtags moved from render-only to indexed. `taggedTopics`, a sibling of `mentionedHandles` in
`shared/richText.ts`, is what a Blab is scanned with at create time, so what `BlabBody` highlights and
what the server indexes read the same tokens off the same input. `gphone_blabber_tags` (`blab_id`,
`tag`) is the child table that scan writes to, and it is what makes a tag feed, a trending aggregate
and a tappable tag possible at all — a body scan alone can render a tag, but it cannot answer "what
else has this tag" without walking every row. A tag is now a `<button>` in both Blabs and DMs, since
`BlabBody` renders both, with the same token discipline as a mention: text through `{text}`, never
`{@html}` (§7).

Three things here were not in the original sketch below, worth naming because a proposal read
afterward should say what changed rather than pretend it was foreseen:

- **The `root_id` and flattened-view rework.** The proposal imagined search landing you in the
  existing nested `Thread` — push a screen per reply, same as opening a Blab from the feed always
  had. That falls over the moment a search result is a reply three levels deep: `Thread` had no way
  to open at that reply without first pushing every ancestor screen on top of it, one tap at a time.
  `root_id` (`server/services/Blabber.ts`) is set once at create from the parent's own `root_id` — so
  it names the true top-level ancestor at any depth, not just the immediate parent — and
  `BlabberRepository.findFlattenedPage` walks one Blab and every reply under it, at any depth, as one
  page. `BlabDetail.svelte` replaces `Thread.svelte` outright: one screen, the root then its replies in
  order, with an `anchorId` so a search result opens already scrolled to the reply that matched rather
  than to the top of the thread.
- **`accounts:search` lives on the shared `accounts` service, not Blabber's own.** Same reasoning as
  `followers`/`following`: a handle or display-name search is a property of the identity table every
  social app posts through, not something specific to Blabber's own tables, so another app gets the
  same search for free rather than reimplementing it.
- **The four-tab `TabBar` is complete.** Search was the one destination left after Notifications
  shipped (see above); it is not anymore.

---

### The add-on path, and the test that measures it

`boundary.test.ts` has long enforced that apps may not reach past the SDK. The opposite
direction went unchecked, and drifted three times before anyone noticed — `sdk/utils.ts`
exporting `blabberTotalUnread`, `Accounts.ts` hardcoding `buildDeepLink('blabber')`, and
`moderation.ts` listing `gphone_blabber` in the reportable allowlist. Each was caught by a
person reading a diff, which is not a mechanism.

`sdk/coreBoundary.test.ts` is the mechanism. It scans `sdk/`, `shell/`, `services/`,
`lib/`, `shared/` and `server/lib/` for the id of any app declaring `core: false`, and
fails on a new one. **Not every app**: `contacts`, `photos` and `notes` are also ordinary
English words, and a blanket rule flagged 55 files on its first run. An add-on is
different in kind — it is not in this repository when a server installs it, so core naming
it cannot mean anything.

Running it measured something worth having in writing. Two apps declare `core: false`,
`notes` and `blabber`, and on the first run both were first-party apps wearing the label:

| Where                     | Then | Now | Why an add-on could not do it      |
| ------------------------- | ---- | --- | ---------------------------------- |
| `sdk/hooks/useBlabber.ts` | 1    | —   | an add-on cannot add an SDK hook   |
| `sdk/hooks/useNotes.ts`   | 6    | —   | likewise                           |
| `services/blabber.ts`     | 10   | —   | nor a store in core's services dir |
| `services/notes.ts`       | 1    | —   | likewise                           |
| `shared/routes.ts`        | 13   | 0   | nor a row in the core route table  |

The route table was the wall: it enumerates every NUI action, and `routes.test.ts`
cross-references it, so an add-on could not have a server half at all. What the Store path
supported was UI-only apps, and Blabber read as proof the add-on story worked when it was
better read as proof of its limits.

The grandfather list is empty now, and that is the finish line rather than an oversight.
Three pieces made it so, the same inversion `registerReportable` did for moderation applied
to routes and to the client data layer:

- **One generic NUI route.** `GENERIC_SERVICE_ACTION` in `shared/rpc.ts` — a single `svc`
  callback carrying `{ service, action, data }`, relayed to `gphone:server:<service>:<action>`.
  Reached from an app through `useService(id).call(...)`. This widened what NUI can reach and
  `docs/security.md` records the correction; `reachability.test.ts` is what keeps the reachable
  set deliberate now that "the UI does not call it" has been shown not to be a control.
- **`service:` on both store factories.** `createCrudStore` and `createPagedStore` take it, and
  the argument that was a NUI action name becomes a **server** action name. Both are exported
  from `@gphone/sdk`, so an app builds its own data layer inside its own directory.
- **Stores moved into the apps.** `apps/notes/store.ts` and `apps/blabber/store.ts`, each
  exporting its own `useNotes` / `useBlabber` rather than core carrying a hook for it.

Leave the list empty. An entry added back is a claim that some app needs to be special, and
the reason belongs in the comment beside it.

### The SDK barrel, split so a manifest can import it

`byNewest is not a function`, thrown from a line that plainly imported it. The cause was a cycle
rather than a missing export: `@gphone/sdk` re-exports `useAppRegistry`, which reaches
`shell/state/registry.ts`, which globbed every app manifest **eagerly** — so a manifest importing the
barrel got a half-initialised module and its bindings came back `undefined`.

Two changes, and the first is the one that matters:

- **`@gphone/sdk/app` is a leaf entry.** `defineApp` and `lazyBadge`, importing nothing that reaches
  the registry. A manifest imports that; only the app's `index.svelte` imports the full barrel.
  `sdk/barrelCycle.test.ts` reads the source and fails a manifest that reaches for the wrong one —
  the first version of that test asserted nothing and would have passed against the bug, which is
  worth remembering as the general case: a test written to prove your own change gets written to
  pass.
- **The component glob is lazy, the manifest glob stays eager.** The launcher needs every manifest
  before it paints and needs no app's code until one is opened, so the split is forced rather than
  chosen. It also gives each app its own chunk — Blabber is 41 kB of a build that no longer pays for
  it at startup.

`lazyBadge` exists for the same reason and emits `0` until its store resolves. A manifest that needs
its store `import('./store')` inside `preload` rather than at module scope.

### The security pass, and two things that moved server-side

`docs/security.md` is the threat model: what is trusted, from whom, and why. It exists because the
assumptions were the undocumented part — a checklist records what was done, and what breaks under a
well-meaning change is what was assumed.

The pass found one property lost and one never held.

**A registered net event is reachable**, full stop. Not "reachable if a NUI route points at it": a
modified client emits `gphone:server:<service>:<action>` directly and never touches NUI, so
`shared/routes.ts` only ever bounded CEF XSS. That was easy to miss while every reachable action
happened to have a route in front of it, and the generic route made it visible by decoupling the two.
Six actions were registered, routed by nothing and called by nothing; they are no longer registered,
and `server/__tests__/reachability.test.ts` keeps that deliberate.

**Eight raw `onNet` handlers sat outside `ServiceEndpoint`** with no rate limit, no authentication
and no payload validation. Six now share `guardNetEvent` in `server/lib/netGuard.ts` — the same two
checks in the same order the endpoint uses, refused silently because nothing is waiting on a reply.
The other two are gone rather than guarded, which is the better outcome and the reason the count
moved:

- **Battery charge.** The client ran the drain timer and reported its own number every fifteen
  seconds. Validating that payload would never have changed what it was, so the event is deleted and
  the server ticks the charge itself. The authoritative version is _smaller_ than the one it
  replaced: one interval and a map, against a client timer plus a report path plus a clamp plus a
  write-skip cache that existed to absorb four redundant writes a minute.
- **Signal zones.** Covered under _Cellular dead zones_ above. The client no longer receives the zone
  list, so `signal:rules` went with it and that service has no raw handler left at all.

The correction worth carrying forward: `docs/security.md` first called all three client-authoritative
values "by design", which let two "has not moved yet" cases read as "cannot move". Only
`PhoneState.isTyping` is genuinely client-owned — the server cannot see DOM focus. The default is
server-authoritative, and anything the client owns needs a reason it _cannot_ move rather than a
reason it has not.

### Notifications as an OS service

`gphone_notifications` is declared in `server/services/Notifications.ts` with
`{ read: 'owner', write: 'server' }` — rows arrive from the server and a player can mark them read
or clear them, which is a soft delete onto `cleared_at` rather than a row disappearing. Three
indexes, one per read: `(citizenid, cleared_at, id)` for the shade, `(citizenid, app, id)` for a
per-app tab, `(citizenid, read_at)` for the unread badges. `gphone_notification_retention` (days,
default 30) prunes on resource start.

Persistence rides on the push channel rather than beside it: `appEventChannel(id).push` with a
`notify` block writes a row as well as raising the toast, for online and offline recipients alike,
and the write is fire-and-forget so it cannot fail the event that occasioned it. Mail, Blabber
mentions, Blabber DMs and new followers all arrive this way.

`useNotifications(appId?)` is the whole client surface — items filtered to one app, that app's
unread count, `markRead`, `clear`, `clearAll` — and it is **generic**, keyed on an app id rather
than on anything the SDK knows the name of. That is what lets any app, including one the SDK has
never heard of, feed a launcher badge: Blabber composes its own from this plus its own mention and
DM counts, through `lazyBadge`. `usePhoneNotification` remains for ephemeral feedback that should
not persist — "Copied to clipboard" is not a notification.

The shade itself groups by app, expands a group in place, and has an archive of cleared items that
can be restored. It opens from the status bar and closes from the home indicator or the backdrop.
Two things specified alongside it are **not** built and are in _Proposed_ below: its drag and swipe
gestures, and the toast visual hierarchy.

### Network and Bluetooth settings

Settings > Network holds two persisted toggles, Cellular Service and Bluetooth Visibility, and
Bluetooth drives the status-bar icon.

**Neither toggle gates anything yet**, and that is worth stating plainly because the UI implies
otherwise. Turning cellular off changes no app's behaviour, and Bluetooth visibility has no
proximity surface to be visible to — the privacy model it exists to serve is in _Proposed_ below.
They are settings that persist a preference, which is the first half of the feature.

### Material 3 color system

Every color in the phone is generated from one seed. `web/src/lib/m3.ts` builds the 34 standard M3
roles plus 13 derived state-layer values with `@material/material-color-utilities`, and
`shell/state/theme.ts` writes all 47 as custom properties onto the phone screen element, where they
inherit into every app. `app.css` holds the shipped dark scheme as literals so first paint and every
jsdom render are correct before any JS runs, and `m3.test.ts` asserts those literals are exactly what
the engine produces.

The wallpaper is generated from the same seed, so a preset and a color dragged off the wheel are the
same operation — a preset is a named color and nothing else. A photo wallpaper instead quantizes the
image and takes its dominant color as the seed.

Two constraints shape the implementation, both from the Chromium 103 baseline (AGENTS.md §6). All
tone maths runs in JS and emits resolved `rgb()`, because `color-mix()` and `oklch()` are out of
reach; M3's state layers are therefore composited numerically into flat opaque tokens rather than
expressed as opacity modifiers. And `sdk/cef.test.ts` fails outright on an opacity modifier applied
to a role token, because Tailwind computes its fallback from the build-time literal and would render
the _default_ seed's color for anyone who changed theirs.

`SchemeVibrant`, not M3's default `SchemeTonalSpot`: the default is documented as "low to medium
colorfulness" and returned a picked color noticeably muted. Measured across eleven seeds, Vibrant
carries about half again the chroma at identical worst-case contrast.

### Cellular dead zones and outages

Reception is real state. `server/services/Signal.ts` holds a city-wide level, a set of dead zones and
per-player overrides, evaluates each player's bars on a two-second poll, and pushes the number.
Before this, `signalLevel` was a `writable(4)` that only Developer Tools could change, on your own
phone — so a dispatch script could not black out a district and an EMP could not exist, because
there was nothing to call.

Global and per-zone are deliberately the **same primitive** with a precedence order — lowest wins —
because two mechanisms drift the first time they disagree. A per-player override beats both in either
direction, which is what lets a script give somebody bars inside a blackout.

Zones live in memory rather than a table. One is placed by another resource at runtime and belongs to
that session; persisting them would mean a jammer outliving the heist that placed it, with nobody
left knowing why a block has no bars.

**The server evaluates, and that was a correction rather than the original design.** The client used
to: it received the zone list and decided its own bars, on the reasoning that the server does not
know where anybody is standing and polling every player is exactly the cost that avoids. That held
only while nothing read the level, and it stopped holding the moment an app was going to degrade at
zero bars — a client that decides its own bars is a client that decides whether it is in a dead
zone. It no longer receives the zone list at all, which is the load-bearing half: a client that
cannot see the zones cannot decide it is outside one. The cost is bounded twice, by an early-out
that reads no coordinates in the ordinary case and by pushing only when the whole-bar value moves.
`docs/security.md` carries the full reasoning.

**What is still unbuilt is the half that matters to apps.** Nothing reads the level yet: every app
behaves identically at four bars and at zero, and `network` remains a permission with no capability
behind it. The remaining question is not mechanical but per-app — Messages, Phone, Blabber, Store,
Bank and Mail need a live connection, while Notes, Camera, Photos, Calculator and Settings are local
and should not care. Giving `network` meaning means every app in the first group grows a zero-bar
path that degrades rather than throws.

### Day-zero schema

gPhone is pre-release — nothing has been installed anywhere and there is no data to preserve — so
the upgrade machinery went away and installation became one step.

`pnpm generate:sql` now writes the **whole** schema into `gphone.sql`: the audit ledger (which has no
`defineService` behind it and lives in `scripts/framework-schema.sql`) followed by every app table, in
the dependency order it already computed. Install is "import one file". That replaced `gphone.sql`
plus a numbered file per service in `sql/apps/`, which worked but cost a filename-order rule every
server owner had to be told, a prefix that renumbered existing files whenever an app was added, and
two places to look for one schema.

`SchemaMigrator` is **report-only**. It used to read `information_schema` at resource start and apply
missing columns and indexes behind a `gphone_auto_migrate` convar; every column it could add is in
the generated file already, so a database that disagrees with the code has not drifted — it has not
been imported. Saying so beats patching it halfway and leaving the operator unsure which half they
have. `gphoneschema` prints the same report on demand, and the hand-written migration written for
`gphone_photos` → `gphone_media` was deleted with the rest.

**This posture expires.** The day this ships to a server with players on it, a drop, a rename or a
type change starts costing data and migrations come back. The absence of them is not "renames are
free"; it is "there is nothing to migrate yet".

### A resource-facing export API

Another resource can now make the phone do things. Before this the entire public surface was one
`exports('SendSystemEmail', ...)` at the bottom of `services/Mail.ts`; everything else in the tree
named `exports` is gPhone _consuming_ somebody else.

`server/lib/exports.ts` holds the scaffolding and `publicApi.ts` the catalogue, registered from
`server.ts` after `./services` so everything has loaded before it can be called. Eight exports:
`GetApiVersion`, `SendSystemEmail`, `SendNotification`, `BuildDeepLink`, `GetBatteryLevel`,
`SetBatteryLevel`, `AddBatteryCharge` and `SetCharging`. Documented in `README.md`, because server
owners are the audience.

Every one returns `{ ok: true, value }` or `{ ok: false, reason, message }` — a bare `false` that
cannot separate "player offline" from "gPhone has not started" is unusable from the calling script —
and none can throw into the caller's resource. Identity is explicit per export: citizenid where it
must work offline, source where it is inherently live, and never an implicit `source` global, because
`TriggerEvent` from another resource makes that the wrong player.
`server/__tests__/exports.test.ts` pins every name and arity, since a rename breaks somebody else's
script and the person who finds out is a server owner reading a runtime error.

`SendNotification` is the first thing in the stack to validate `app` at all — the field was mandatory
and its value was whatever arrived. External callers group under `ext_<resource>` with a required
label, and `defineApp` refuses an `ext_` id, so the reservation is enforced rather than conventional.

`SetCharging` is a state rather than a top-up: the drain loop is client-side, so charging reverses it
instead of racing it with repeated writes.

### Settings that follow the character

Every preference lived in `localStorage`, which is per-PC and shared between characters — a theme did
not follow a player to another machine, and a second character on the same PC inherited the first
one's phone.

`gphone_settings` is key-value, `(citizenid, app, setting_key)` unique, written with
`ON DUPLICATE KEY UPDATE`. Key-value rather than one JSON document per player because it maps 1:1
onto `useStorage(app).setItem(key, value)` — so the SDK gained no new concepts and **no call site
changed** — and because per-key writes cannot clobber each other the way a read-modify-write on one
document does.

`localStorage` stayed on as a cache, which is what let the API remain synchronous: `getItem` is
called once per store at module scope, so making it a promise would have meant rewriting every call
site. Reads hit the cache, writes go local-first then to the server debounced per key, and hydration
re-reads the live stores. It runs at page load rather than from `bootstrapStores` — that is gated on
the phone being _opened_, which would paint the shipped theme and flip to the player's in front of
them — and again on character load, since the CEF page never unloads.

A wallpaper **image** is the one exception, via `sync: false`: it is a base64 data URL of unbounded
size. The seed and mode still sync, and they are what generate the scheme.

### `gphone_photos` → `gphone_media`

The photos table held one payload column, `image mediumtext` holding base64, which can only ever be a
photo. It is now `gphone_media` with `kind` — an
`enum('photo','video','audio','gif','sticker','file','link')`, deliberately over-provisioned because
widening one later is another hand-written migration — plus `data` (the renamed `image`, nullable
now), `url` for hotlinks, `thumbnail`, `mime_type`, `width`, `height`, `duration_ms`, `byte_size` and
`alt_text`.

**The service and app id are still `photos`.** Those are keys — the directory, the storage namespace,
the event segment, the `?app=photos` deep link — so renaming one is a data migration; a table name is
a key to nothing outside SQL, so the `table:` override moved it for free.

`kind` and `data` are the only client-writable columns. The other nine are `clientWritable: false`
until a feature writes them, because a column a client can set before any caller needs it is
unconstrained surface (§2.9).

There is no migration, and there does not need to be one: gPhone is pre-release, so the schema is
imported whole from the generated `gphone.sql` against an empty database. A migration was written and
then deleted along with the rest of the upgrade machinery — see _Day-zero schema_ below.

`MediaThumb` in `sdk/ui/` draws a row by its `kind`, and the gallery, the full view and the picker
all go through it — four copies of "what does this look like" is four places to forget `kind` exists.
Video renders as its poster frame with a play badge rather than a `<video>` element: the game is on
Chromium 103 and the bytes would have to arrive base64 across the NUI bridge, which is the constraint
at the top of this section. `AddMedia` is the creation path, since the camera can only ever produce a
`photo` — without it the other six kinds had no way to exist.

Message attachments go through the same renderer. They used to carry a bare base64 string, which made
every attachment a photo by construction — a voice note had nowhere to say what it was. They now carry
a `MediaPreview`: enough of the row to draw it, and **not** the uploader's `citizenid`. That omission
is the load-bearing part rather than tidiness, and it is `publicColumns`' reasoning one table over — a
conversation is shared, so anything the join selects reaches every participant, and the citizenid is
the field that ties a picture back to somebody who only meant to send it.

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

### Camera capture resolution is tied to display scale

`apps/camera/index.svelte` crops `containerRef.getBoundingClientRect()` against
`window.innerWidth`/`Height`, so what a photo _is_ depends on how large the phone happened to be
drawn when it was taken. Settings > Display scales the frame with a `transform`, which means the same
shot produces a different image at a different setting.

This used to be filed as the blocker for wallpapers. It is not — wallpapers ship, and a photo can be
one — but it is still wrong on its own terms, and it is the reason a photo wallpaper is sharper or
softer depending on a setting that has nothing to do with the camera. Capture belongs at a fixed
resolution independent of the on-screen box.

### Bluetooth proximity, and the anti-doxxing model it exists for

Bluetooth Visibility is a persisted toggle and a status-bar icon. The feature underneath is
short-range peer-to-peer between nearby players — contact exchange, local file drops — that works
where there is no cell reception.

The privacy argument is the part worth keeping. Phone systems that expose a character's name or
number to anyone nearby whenever the phone is out cause accidental self-doxxing, and the person doxxed
never chose it. So visibility is the player's switch: off means invisible to proximity scans and
unsolicited shares are refused, and the setting persists. That is why the toggle shipped ahead of the
capability rather than with it — the default and the persistence are the parts a player relies on.

Nothing enumerates nearby players yet, on either side.

### Notification toast hierarchy

Toasts carry a title and a body and, for messages and contacts, an avatar. The specified layout also
has the source app's icon and its name in a smaller header face above the primary line, so a toast
says which app is talking before it says what about.

`ToastHost.svelte` has no access to an app icon today: a toast is raised by kind, not by app id, so
this needs the toast payload to carry the originating app and the launcher's manifest lookup to be
reachable from the shell.

### Notification shade gestures

The shade opens from the status bar and closes from the home indicator or the backdrop. It does not
drag open, and rows do not swipe to clear.

Handlers for the drag existed and were wired to nothing — removed in the commit that found them,
because they could not have worked as written: the drawer is `inset-0` around a scrolling list, and
capturing the pointer on its own `pointerdown` takes every touch that starts on a notification row.
Doing it properly needs a grab handle to attach to and a transform that follows the finger, and
swipe-to-clear needs per-row pointer handling that does not fight vertical scrolling.

### Phone-state exports

The export API under _Shipped_ left one group out — the one still needing a mechanism rather than a
wrapper. (The signal exports it also deferred have since shipped alongside the zones themselves.)

**Phone state and identity** — `GetPhoneNumber(citizenid)` and its inverse `GetCitizenId(phone)`
(`PlayerDirectory` already resolves both directions), `IsPhoneOpen(source)`,
`SetPhoneEnabled(source, enabled)` for confiscated or jailed, `OpenApp(source, appId, props)` and
`AddContact(citizenid, contact)` for a job handing out its dispatch number. Each needs a client
round trip that does not exist yet, which is why they waited.

**Deliberately out of scope**, listed so nothing above reads as covering it: client-side exports for
other resources' client scripts beyond what signal polling needs; anything letting an external
resource _read_ a player's messages, photos or notes, which is a privacy surface rather than an
integration one and stays closed; and a general "run any service action" export, which would hand out
the whole `ServiceEndpoint` surface without the payload validation and rate limiting §2.9 puts in
front of it.

### Blabber, next iteration

Most of what this section originally proposed has since shipped and moved up: the tabbed shell, the
composer as a FAB, identity as a small avatar, the follow graph, the notifications tab, and now search
and hashtags. **What is left is the media and moderation work below.**

The end state is a signed-up-only tabbed shell — public feed as the default, the feed of people you
follow one tap away, search and notifications in a bottom nav. All four exist.

Decisions already settled, recorded so they are not re-litigated:

| Decision                | Choice                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Tabs                    | Public feed (default), Following, Search, Notifications — bottom nav — done         |
| Identity                | Small avatar top-right, opening a sheet for switch / claim / edit profile — done    |
| Composer                | FAB, matching Messages' "Start Chat" and Contacts' "Add Contact" — done             |
| Notifications           | The shared `gphone_notifications` OS service, not a per-app table — done            |
| Follow graph            | `gphone_account_follows`, declared on the shared `accounts` service — done          |
| Public-feed affordance  | **Ear** — pairs with Mouth, one speaks and one listens. No reaction bar in a feed   |
| Reactions / emoji / GIF | Private surfaces only; Blabber DMs first, Messages adopts the same primitives later |
| Media                   | Generic `gphone_media` table via the `table:` override; app id stays `photos`       |

Search as the fourth tab, and search and hashtags underneath it, both shipped — see "Search,
hashtags, and the flattened view a search result needed" under Shipped, alongside "The notifications
tab, and the tab nobody could open" for the destination search completed the nav with. Read this
section's earlier proposal for either as superseded, not as pending: the flattened `root_id` view a
search result needed was not foreseen here at all, and `accounts:search` landed on the shared
`accounts` service rather than a Blabber-owned one, matching how `followers`/`following` already work.

#### Media, private-surface richness, and moderation

- **The `gphone_media` rename**, below — the prerequisite for everything else in this step. Bundle the
  `gphone_blabber_likes` → `gphone_blabber_ears` rename into the same migration file: doing it while
  Blabber is a fresh `core: false` add-on is far cheaper than later.
- **Blab attachments**, `gphone_blabber_attachments` (`blab_id`, `citizenid`, `media_id`), ordered by
  `id ASC` as Messages already relies on. Reuse `resolveOwnedAttachments` from `Messages.ts` — or lift
  it to `server/lib/` — so a `media_id` the poster does not own is dropped rather than trusted, and
  reuse `PhotoPickerModal`'s existing `multiSelect`. Hydrate through the Blabber repository subclass,
  batched per page.
- **Ear.** Rename Like across the UI copy, the wire actions (`likeBlab`/`unlikeBlab` →
  `earBlab`/`unearBlab`, `blabber:like`/`unlike` → `blabber:ear`/`unear`), the `BlabEngagement` fields
  (`likes`/`likedByMe` → `ears`/`earedByMe`) and the table. Keep Mouth — the pair is the point. Route
  renames must land in all three layers plus the mock or the feature silently no-ops (§8), and
  `routes.test.ts` cross-references them. Keep the two-literal `fetchNui` calls: a computed action name
  is invisible to that test.
- **Private-surface richness, Blabber DMs only.** No reaction bar and no GIF button on a Blab
  composer; a public post gets Ear and nothing else. `gphone_account_reactions` declared as a shared
  table now (keyed on account plus target) so Messages needs no migration when it adopts this. New
  `EmojiPicker`, `GifPicker` and `ReactionBar` primitives, exported from `components.ts` so they are
  reachable — a primitive nobody can import is not a primitive — and wired into `DmComposer` and the
  DM thread only. GIF sourcing goes through `gphone_gif_provider` / `gphone_gif_api_key` convars with
  the **server** calling the provider, so the key never reaches the client, and a stored `url`
  validated against an allowlist of that provider's CDN hosts before it is ever rendered: an
  unvalidated client-supplied URL rendered in CEF is an IP-leak beacon and a way to display
  unmoderated content (§2.9). Server-side fetch, no new npm dependency.
- **Report and block.** `REPORTABLE` in `server/lib/moderation.ts` lists only messages and photos, so
  a Blab, a DM and an account cannot be reported at all, and nothing ever writes `moderated` on those
  tables — Blabber only respects the status defensively through `visibleTarget`. Add `gphone_blabber`,
  `gphone_blabber_dms` and `gphone_accounts` with preview columns, and surface the existing
  `ReportDialog` from `BlabRow`, the DM thread and profiles. **Block/mute** is a new shared table
  alongside follows, and it matters most once strangers can DM you: a block has to filter the
  blocker's feeds, suppress notifications and refuse DMs **server-side**, because a client-side filter
  is not a block.

#### Deliberately out of scope

Listed so nothing above reads as covering them: Messages adopting the emoji, GIF and reaction
primitives, and threaded replies in Messages; video and voice **capture**, which the schema
accommodates but no capture path exists for; a quote-Blab composer, though `mouthBlab` already accepts
a body with no UI to supply one; pull-to-refresh and a new-posts indicator; and whether Blabber should
stay `core: false` at all once it is a flagship app.

New server logic here gets a server test (§9), and the ones worth naming in advance: a notification
row per kind with `read_at` clearing the count, tag extraction agreeing with `tokenizeRichText` on the
same input, a GIF URL off the host allowlist being refused, and a blocked account being unable to DM
or appear in a feed. `routes.test.ts` and `appEventContract.test.ts` are what catch a missing NUI or
push layer — the failure mode that silently does nothing in game.

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
   boundary, and per-column validation derived from the schema. The chokepoint is no longer the only
   guarded path: `guardNetEvent` applies the same two checks to the raw `onNet` handlers that cannot
   go through the endpoint, and `reachability.test.ts` keeps the registered set down to what the app
   uses. `docs/security.md` is the model.
5. **An economy primitive** — built. `addMoney` on both framework paths, failing closed, and
   `transfer` with a compensating refund and a `PaymentOutcome` union that cannot be mistaken for
   success. Best-effort, not ACID: there is no transaction spanning another resource's money system.
   Offline recipients are refused rather than dropped.

6. **A resource-facing export API** — built. `server/lib/exports.ts` and `publicApi.ts`, fifteen
   exports, discriminated outcomes, `GetApiVersion`, and a contract test pinning every name. Phone
   state and identity are the one group still out — see _Phone-state exports_ above — because each
   needs a client round trip that does not exist yet.

**`location` and `network` are still permissions with no capability behind them**, but for different
reasons now. `location` has nothing behind it at all. `network` has state — dead zones, a global
level and per-player overrides all exist and reach the phone — and no _consumer_: every app behaves
identically at four bars and at zero. Closing that is per-app work rather than platform work, and it
is the open half of _Cellular dead zones and outages_ under Shipped.
