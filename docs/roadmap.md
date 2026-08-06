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

---

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
- **Base64 will not carry video.** `gphone_photos.image` is `mediumtext` holding base64; a video or
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

### Cellular dead zones and outages

The Cellular Service toggle persists a preference and gates nothing. The proposal it came from went
further: the server holding outage state and a set of spatial dead zones, the game client polling the
player's coordinates against them, and signal level pushed down from that rather than set by hand.

What has to be decided first is what "no signal" means to an app, and the honest answer is that it is
a per-app question. Messages, Phone, Blabber, Store, Bank and Mail need a live connection; Notes,
Camera, Photos, Calculator and Settings are local and should not care. `network` is already a
declared permission with nothing behind it (see the capabilities list below), and this is the
capability that would give it meaning — which also makes it the point at which every app needs a
0-bar path that degrades rather than throws.

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

### Blabber, next iteration

Blabber today is **one screen**: a permanently-expanded composer pinned above the global public feed,
a "Posting as @x" strip, a prominent account switcher, and a text link to DMs. No tabs, no follow
graph, no search, no notifications list.

The intent is a signed-up-only tabbed shell — public feed as the default, the feed of people you
follow one tap away, search and notifications in a bottom nav — with the composer demoted to a FAB and
identity demoted to a small avatar in the top-right.

Decisions already settled, recorded so they are not re-litigated:

| Decision                | Choice                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Tabs                    | Public feed (default), Following, Search, Notifications — bottom nav                |
| Identity                | Small avatar top-right, opening a sheet for switch / claim / edit profile — done    |
| Composer                | FAB, matching Messages' "Start Chat" and Contacts' "Add Contact" — done             |
| Notifications           | A real table, which also raises native phone notifications                          |
| Follow graph            | `gphone_account_follows`, declared on the shared `accounts` service — done          |
| Public-feed affordance  | **Ear** — pairs with Mouth, one speaks and one listens. No reaction bar in a feed   |
| Reactions / emoji / GIF | Private surfaces only; Blabber DMs first, Messages adopts the same primitives later |
| Media                   | Generic `gphone_media` table via the `table:` override; app id stays `photos`       |

#### 1. Search and Notifications as tabs

The nav exists — see "The follow graph, and a nav with somewhere to go" under Shipped — with Feed and
Following in it. The two remaining destinations are waiting on the servers below them, in steps 2 and
3, and a tab that apologises for itself is the Store's invented add-ons one layer down.

#### 2. Notifications

`gphone_blabber_notifications`, `access: { read: 'owner', write: 'server' }` — rows arrive from the
server and never the phone, so nothing becomes client-writable and create/update are not registered
(§10). `account_id` and `actor_account_id` onto `gphone_accounts.id`, a
`kind enum('mention','follow','reply','ear','dm')`, a nullable `blab_id`, a nullable `read_at`, and a
key on `(account_id, read_at)`.

This replaces `unreadMentions` in `web/src/services/blabber.ts`, an in-memory counter that resets on
resource restart and can only ever count what arrived while subscribed. A stored count is also the
only way to build a notifications **list**, which a counter can never become.

**One write path, two outputs.** `notifyMentions` already fans out through
`appEventChannel('blabber').pushMany(...)` with a `notify` option, which is what raises the phone-level
toast. Generalize it to write the row _and_ push, for every kind, so the in-app tab and the native
notification read from one source and cannot disagree. Keep the existing discipline: fired after the
row is written, never allowed to fail the originating action, and `PushOutcome` distinguishing
`offline` from delivered (AGENTS.md §8). A `mark read` action clears the badge; the manifest's
`badgeStore` switches to the unread count and its subscription stays at **module scope**, which is the
reason the current one keeps counting while the app is closed.

DMs appear here as a notification kind _and_ keep their own unread badge on the header DM icon. Those
are two different questions — "anything new?" versus "unread in this thread".

#### 3. Search and hashtags

Hashtags are render-only today: `tokenizeRichText` emits a `tag` token and `BlabBody` renders it as a
non-interactive `<span>`. There is no tag storage, so "popular recent hashtags" has nothing to
aggregate.

- **`taggedTopics(input)`** as a sibling of `mentionedHandles` in `shared/richText.ts`, so what the UI
  highlights and what the server indexes cannot disagree — the same reasoning that file's header
  already gives for living in `shared/`.
- **`gphone_blabber_tags`** child table (`blab_id`, `tag`), written at create time. That buys three
  things a body scan cannot: an indexed tag feed, a real trending aggregate, and tappable tags.
- **Tags become tappable in Blabs and DMs at once.** A mention is already a `<button>`; give the tag
  the same treatment with an `ontag` callback that switches to the Search tab with that tag loaded.
  One change covers both surfaces, because the DM thread renders bodies through `BlabBody` too. Keep
  the token discipline exactly as it is — tokens through `{text}`, never an HTML string through
  `{@html}` (§7). Turning a `<span>` into a `<button>` changes nothing about that.
- **Search tab**: a `SearchBar` over three server-side searches — accounts by handle or display name,
  Blabs by body, tags — plus trending shown before anything is typed. Server-side, not
  `filterByQuery`, which filters an in-memory list that a public feed never fully loads. Every search
  action needs `paging`; `defineService` throws for a public read without it (§10). While here, fix
  `SearchBar`'s `use:focus` action, whose body is an empty stub, so the field actually autofocuses.

#### 4. Media, private-surface richness, and moderation

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

### `gphone_photos` → `gphone_media`

The photos table is `gphone_photos` today and holds one base64 `image` column. The proposal is to
rename it to `gphone_media` via the `table:` override on the `photos` service — **the service and app
id would stay `photos`**, so event names, `?app=photos` deep links, the `gphone:photos:` storage
namespace, `usePhotos` and the launcher label are all untouched — and to replace the single column
with a shape that can hold more than one kind of thing:

| Column        | Type                                                          | For                                              |
| ------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| `kind`        | `enum('photo','video','audio','gif','sticker','file','link')` | default `photo`                                  |
| `data`        | `mediumtext` NULL                                             | base64 for locally captured photos — was `image` |
| `url`         | `varchar(512)` NULL                                           | hotlinks: GIFs, remote video                     |
| `thumbnail`   | `mediumtext` NULL                                             | poster frame for video and GIF                   |
| `mime_type`   | `varchar(64)` NULL                                            |                                                  |
| `width`       | `int` NULL                                                    | reserve layout space so a feed does not reflow   |
| `height`      | `int` NULL                                                    | as media loads                                   |
| `duration_ms` | `int` NULL                                                    | video and audio                                  |
| `byte_size`   | `int` NULL                                                    |                                                  |
| `alt_text`    | `varchar(255)` NULL                                           | accessibility, and what RCS carries              |

`audio` covers voice clips, `file` covers RCS-style transfer, `link` covers rich URL previews and
`sticker` covers tapback-adjacent stickers. The enum is **deliberately over-provisioned**, because
widening one later is another hand-written migration.

The migration is hand-written and lives in `sql/`: rename the table, rename `image` → `data`, add the
new columns. An existing install must run it or lose its gallery, and the file has to say so. It
touches `server/lib/moderation.ts` (`REPORTABLE.gphone_photos`), `ReportDialog.svelte`'s `targetTable`
union, the FK in `Messages.ts`, `MessageRepository.ts`'s join, and the audit and report tests.

The rename is a **consequence** of needing more than one storage shape, not a tidying exercise — the
base64 constraint above is the actual motivation.

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
either and nothing changes, because there is no hook, endpoint or client surface to grant. The
Cellular Service toggle in Settings > Network does not change this: it persists a preference and
nothing reads it. _Cellular dead zones and outages_ above is the proposal that would give `network`
something to mean.
