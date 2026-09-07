# Security model

What micaOS trusts, who it trusts it from, and why. `AGENTS.md` §2.9 and §7
carry the rules this document explains; where they disagree, `AGENTS.md` wins
and this file is wrong.

Written after a pass over the resource's entry points. It is not a checklist — a
checklist tells you what was done, and what matters here is what is _assumed_,
because an assumption nobody wrote down is the one that gets broken by a
well-meaning change.

**Last verified against `9a8e4909` (2026-09-01).** Entry-point counts, the
accepted-risks register, and the add-on-trust claims below are only as fresh as
that commit — a service or app added since has not been weighed against them.

---

## The one rule

**The phone is an untrusted client.** Every payload it sends is
attacker-controlled, and the server authorises everything on its own account.

Two separate reasons, and they have different blast radii:

- **CEF XSS.** Injected script in the page can `fetch`
  `https://<resource>/<callback>` and invoke any **registered NUI callback**
  (§7). That is why player-supplied strings never reach `{@html}` unsanitised,
  and why an anchor is never in the DOMPurify allowlist.
- **A modified game client.** It can `TriggerServerEvent` **any server event
  directly**, with no NUI involved at all.

The second is wider than the first, and it is the one that is easy to forget.

### The route table was never a security boundary

`shared/routes.ts` maps NUI action names to server events, and `routes.test.ts`
cross-references it against the `fetchNui` calls, the server registrations and
the browser mock. Its job is catching a **missing layer** — the failure that
silently does nothing in game.

It bounds **neither**. A modified client never touches NUI at all, so the route
table was never in its path. And CEF XSS is not actually confined to the route
table either: the generic `svc` callback (`shared/rpc.ts`,
`client/services/Relay.ts`) relays any `{service, action}` pair matching a name
pattern, not just the entries `shared/routes.ts` lists, to
`mica:server:<service>:<action>`. So:

> **A registered net event is reachable. "The UI does not call it" is not a
> control.**

This was easy to miss while every reachable action happened to have a route in
front of it. The generic service route decoupled the two and made it visible —
`accounts:delete`, `notifications:get`, `notifications:delete` and
`blabber_dms:delete` were all registered, routed by nothing, and called by
nothing. They are no longer registered. `server/__tests__/reachability.test.ts`
keeps that deliberate.

**Correction to the record.** The commit that added the generic route claimed it
did not widen what NUI can reach. That was wrong: the route table is a strict
subset of registered actions, so unrouted ones became reachable from the page as
well as from a modified client. No privilege escalation and no cross-player
access resulted — every one was owner-scoped — but the claim should not be
trusted as written.

---

## Entry points

### 1. NUI callbacks

Named routes in `shared/routes.ts`, plus the generic `svc` callback, plus the
client-only actions that never reach the server. All of them land in
`ServiceEndpoint.registerEvent`, which applies, in order:

1. **Rate limit** — `allow(source, service, action)`, fixed 60-second window,
   `mica_rate_limit` per window. Before the player lookup, so a flood does not
   make the server walk the framework's player table. Cleared on
   `playerDropped`, because FiveM reuses server ids.
2. **Authentication** — no loaded character, no answer.
3. **Declared input, for a custom action** — the payload is parsed against the
   action's contract (`shared/contracts/<service>.ts`, or the add-on's own
   server file; MICA-195) before the handler sees it. Objects are strict, so an
   unknown key is refused rather than ignored; a cap refuses rather than
   truncates; an id must be a positive integer. A handler registered for an
   action the contract does not declare fails the resource at start, and
   `server/__tests__/reachability.test.ts` proves the two agree both ways.
4. **Payload reduction, for generic CRUD** — every key checked against the
   schema's `clientWritable` set. `id`, `citizenid`, `created_at`, `updated_at`
   and `status` are never client-writable.
5. **Per-column validation** — length, enum, and `int` range rules derived from
   the schema, because non-strict MySQL truncates or clamps silently: row
   written, success reported, data quietly wrong.
6. **Ownership** — `update` and `delete` carry a `citizenid` predicate. A row id
   is never authorisation. Shared rows check membership instead.

What a player is told when any step refuses is bounded the same way. Only the
message of a `PlayerFacingError` (`server/lib/errors.ts`) or a `SchemaError`
reaches the `fetchNui` reply and therefore a toast; every other throw, a driver
error with statement text or a `[Repository]` error naming a table, is logged
with its stack on the server and answered with one generic sentence. A handler
that means to tell the player something throws the player-facing kind.

Since MICA-216 that reply also carries a **message key** beside the English text
(`{ error, key, params }`), and the shell resolves the key through its `server`
catalog so the refusal reads in the player's language. The key widens nothing:
it names a catalog entry, never a table or a statement, and a key the catalog
lacks falls back to the English beside it. `params` are the values the handler
chose to interpolate, and they are bounded on the way in (`parseNotify` keeps
short scalars only). What a player learns from a refusal is exactly what the
handler wrote, in either language.

### 2. Raw `onNet` handlers

**Ten, across six files**, and they fall into two categories that need different
things said about them. They sit outside `ServiceEndpoint` because they answer
fire-and-forget events with no callback id, so they cannot go through it.

This census used to read "six, in `Phone.ts` and `Battery.ts`", and it was wrong
in both directions: three mica-named handlers had been added since it was
written, and the **framework-named** category below had no row at all — which is
how an inventory that reads exhaustive never mentioned it. Count from the tree,
not from this page:

```sh
grep -rn "onNet(" server --include="*.ts" | grep -v __tests__
```

**That prints twelve lines for ten handlers.** Two of them are not entry points:
`ServiceEndpoint.ts`'s generic registrar, which is the machinery behind category
1 of this document, and the worked example in `netGuard.ts`'s doc comment.

Keep both stages of the pipe if you reproduce it. The second one silently drops
a thirteenth line — the copy of this very command inside `netGuard.ts`'s
docblock, which matches `onNet(` and is filtered out only because it also quotes
`__tests__`. Drop `grep -v __tests__` and the total moves for a reason that has
nothing to do with the handlers.

`server/__tests__/netGuardCensus.test.ts` holds both copies to the tree: it
reads the numbers out of `netGuard.ts`'s comment **and out of the four claims on
this page** — the bold count opening this section, the printed-lines sentence
just above, and the two category headings below — then compares each against a
fresh scan. The assertion is "this is true" rather than a third copy of the
count living in the test, which is the copy nobody would think to check.

It reads those sentences rather than asking this page to carry a table of digits
for the test's benefit, because a table would be one more copy sitting beside
prose saying the same thing in words, and the prose is the part you are actually
reading.

**Only those four claims are held; the rest of this section is yours.** The
narrative around them — that the census used to read six, that handlers had been
added since, that the framework-named category was three until ESX — is checked
for nothing, and can be reworded or removed freely. What the four claims reserve
is their _shape_: the bold count opening this section, the bold sentence saying
what the grep prints, and the two `####` category headings that end in a number.
Each shape must occur exactly once on this page. Write a new sentence that
happens to take one of those shapes and the suite fails rather than quietly
reading its number out of the wrong sentence — which is the failure this whole
section is about, so it is caught rather than trusted. Reword one of the four
out of shape and it fails too, saying which.

#### mica-named — nine, every one guarded

| Event                                | Handler                           |
| ------------------------------------ | --------------------------------- |
| `mica:server:phone:start`            | `server/services/Phone.ts:478`    |
| `mica:server:phone:answer`           | `server/services/Phone.ts:487`    |
| `mica:server:phone:end`              | `server/services/Phone.ts:505`    |
| `mica:server:phone:simulateIncoming` | `server/services/Phone.ts:591`    |
| `mica:server:admin:setBattery`       | `server/services/Battery.ts:318`  |
| `mica:server:battery:load`           | `server/services/Battery.ts:391`  |
| `mica:server:contacts:share`         | `server/services/Contacts.ts:148` |
| `mica:server:shell:setOpen`          | `server/lib/PhoneOpenState.ts:32` |
| `mica:server:shell:checkPhoneItem`   | `server/lib/phoneItem.ts:144`     |

`guardNetEvent` in `server/lib/netGuard.ts` is the preamble for all nine,
applying the same two checks in the same order the endpoint uses: rate limit
first, then the authenticated player lookup — `getPlayer` walks the framework's
player table and a flood should not make the server pay for that. Refused
**silently**, because there is nobody waiting on a reply to be told;
`ServiceEndpoint` answers its refusals only because `fetchNui` would otherwise
hang for fifteen seconds.

Payloads are narrowed by `phoneNumberFrom` and `levelFrom` in the same module.
The second is worth naming: `Number(null)` is `0` and `Number('')` is `0`, so a
client sending nothing at all used to produce a valid "0% battery" rather than a
refusal.

`mica:server:admin:setBattery` is gated on `isAdmin(source)`, as are the
moderation actions in `Reports.ts`. Privilege is checked against the ace list,
never against which route was used.

Three are gone rather than guarded — `battery:save`, `battery:useItem` and
`signal:rules`. The first and last existed so the client could tell the server
something the server now decides for itself. `battery:useItem` is a different
shape and the same answer: it consumed an inventory item on a raw event any
client can emit, while nothing in micaOS ever emitted it and the framework's
usable-item callback did the job properly. Deleting an entry point beats
hardening one. `Signal.ts` has no `onNet` left at all.

#### Framework-named — one, and this is the category that was missing

| Event                          | Handler                   |
| ------------------------------ | ------------------------- |
| `QBCore:Server:OnPlayerLoaded` | `server/lib/shell.ts:188` |

**This was three until ESX support landed, and the drop is a real reduction in
surface rather than a recount.** `Settings.ts` and `Battery.ts` each registered
this name themselves, pasted from `shell.ts` — which is why MICA-136's payload
bug had to be fixed in three places at once. `shell.ts` now owns every
player-loaded event and exposes `onPlayerLoaded(name, handler)`; the other two
are one-line subscribers that are handed an already-resolved source and are
never shown a payload to misread. Adding ESX would otherwise have made it a
fourth listener in each of three files, and the next framework a fifth.

It is easy to miss precisely because it does not look like micaOS's surface: the
name belongs to the framework, the event is one micaOS listens to rather than
defines, and `eventNames.test.ts` — which scans for `mica:` names — has nothing
to say about it. **A registered net event is reachable no matter whose name is
on it.**

It is `onNet`, not `on`, and that is deliberate rather than sloppy: this name is
fired **from the client**, so a plain `on()` throws "was not safe for net" the
moment a player loads. Network-safety is per-resource, so another resource
declaring it net-safe does nothing for micaOS's own handler.

Verified against `qbx_core` 1.24.0 as vendored, because the reasoning here was
wrong for a long time in a way that happened to reach the right answer. It is
qbx_core's **own client character flow**, not its `bridge/qb/` compat shim:
`client/character.lua:280` and `:482` fire `TriggerServerEvent` with **no
payload**, and `qbx_spawn/client/main.lua:218` is a third emitter in a different
resource. A sweep of every resource on a reference server found no local
`TriggerEvent` of this name anywhere.

That matters because the old note claimed `onNet` also received a _local,
Player-object_ trigger for this name, and justified trusting the payload on that
basis. It does not. The local Player-object trigger is
`QBCore:Server:PlayerLoaded` — a **different event** — at
`qbx_core/server/player.lua:1064`. The **matching `QBCore:Server:PlayerLoaded`
listener beside it is `on()`, is local-only, and is not an entry point** — which
is why this category counts one and not two.

Vanilla `qb-core` was not available to check. If it ever does fire this name
locally, that arrives with `source` 0 and is refused, and the `on()` twin is
where such a core belongs.

**ESX support added a fourth player-loaded handler and no fourth entry point,
and the distinction is the whole reason this section counts what it counts.**
`server/lib/shell.ts:216` listens for `esx:playerLoaded`, and it is registered
with `on`, not `onNet`. es_extended raises that name server-side and locally —
`TriggerEvent('esx:playerLoaded', playerId, xPlayer, isNew)`, not
`TriggerServerEvent` — which is precisely the property
`QBCore:Server:OnPlayerLoaded` lacks and had to be hardened for. Network-safety
is per-resource, the fact this section already leans on one direction over, so
registering only `on` leaves the name un-net-safe inside micaOS and a client
emitting it reaches nothing here. There is no forged target to refuse, so there
is no `loadedPlayerSource` on that path and the payload is the identity, on the
same terms as the `QBCore:Server:PlayerLoaded` twin.

Adding an `onNet` twin to it "to be safe" would invert that: it would declare
the name net-safe for micaOS and manufacture a client-reachable entry point
es_extended does not itself have. §2.9's rule against registering an action the
app does not use holds for a framework-named event exactly as for a mica-named
one — and this file is the record of what happens when a census organised by
micaOS's own event names misses a category. **So ESX added a player-loaded
handler and no entry point, and neither number above moved on its account.** If
a fork is ever found firing this name from a client, the fix is an `onNet` twin
routed through `loadedPlayerSource`, never a payload read.

**It derives the target from the connection**, via `loadedPlayerSource` in
`server/lib/shell.ts`. `source` is runtime-set and unforgeable; the payload may
only _agree_ with it, and one naming anyone else is dropped. That function calls
`guardNetEvent` itself, so it is behind the same rate limit and the same
loaded-character check as the nine above — counted before the comparison, so a
flood is charged for every attempt rather than only the honest ones. Its bucket
is keyed to the caller's own source, so an attacker cannot exhaust a victim's.

Until MICA-136 landed, the three listeners this one replaced each read
`player?.PlayerData?.source` and none called `guardNetEvent`, so a modified
client could drive a settings rehydrate, a shell rehydrate, or a battery push
**against an arbitrary server id it named itself** — and could seed the battery
maps with ids `playerDropped` would never clean, by a route those handlers never
see. No write and no cross-player read resulted, so the cost was unsolicited
state churn rather than disclosure, but the shape was wrong: identity comes from
the connection, never from the payload, the same rule the exports contract
states below.

**A refusal is logged once per connection**, deduped and cleared on
`playerDropped` so a recycled server id does not stay silenced. That matters
because the check added here is a _precondition on the event that announces a
character loaded_: on a core that fires it before the framework has registered
the character, settings and battery would otherwise never load and nothing would
say so.

It is guarded, not eliminated, so the census below still counts it — ten in
total, nine mica-named and this one.

### 3. Exports

**A different trust boundary.** Exports are called by other _resources_, not by
players. A hostile resource is out of scope: it already has server-side
execution and could do anything regardless.

What the contract protects against is a **buggy** one. Hence: arguments
validated, discriminated outcomes rather than bare booleans, never throwing
across the boundary, identity passed explicitly rather than read from an
implicit `source` global — `onNet` also registers a local handler, so
`TriggerEvent` from another resource would otherwise supply the wrong player.

`SendNotification` validates its `app` against known services and namespaces
external callers under `ext_`; `AddMedia` refuses a `url` or `thumbnail` whose
scheme is not `http(s)` or `data:image`; `SendMessage` refuses a `from.number` a
character holds, so a resource can text as a business or a line but never as a
player, and the row it writes carries `external_sender` so the recipient's phone
never mistakes it for their own words -- nor lets them edit it as such.

**The client has an export surface too, and it is not a boundary at all**
(MICA-224). `client/lib/publicApi.ts` lets a client script open, close, toggle
or disable the device, read the framework's phone number and raise a toast. All
of it acts on the calling client's own `DeviceState` and NUI, which a modified
client controls outright already, so nothing server-side trusts any of it:
`IsPhoneOpen` on the server is a mirror of what the client last said, and a
confiscation that has to hold is the server export's job. The client set exists
for latency and convenience, not for enforcement, and the README says so where
the names are listed.

**The one rate limit at this boundary is per calling resource, not per player.**
`SendMessage` allows 120 calls a minute from each resource and answers
`rate_limited` past that (`rateLimited` in `server/lib/exports.ts`). The threat
it answers is a stuck loop in a well-meaning script, which the per-source
limiter in `rateLimit.ts` cannot see: an export has no source. Nothing else at
this boundary is limited, deliberately: a hostile resource is out of scope, and
a bug that calls `SendNotification` in a loop costs a notification row per call
where a text costs a thread, a participant and a push.

---

## Client-authoritative values

**One is legitimate. Two have since been fixed** — and this section used to call
all three "by design", which is exactly what let two "has not moved yet" cases
read as "cannot move". That framing was wrong and worth correcting: the default
is server-authoritative, and anything the client owns needs a reason it _cannot_
move rather than a reason it has not.

### `DeviceState.isTyping` — legitimately client-owned

The server cannot see DOM focus. There is no server-side version of "this player
has a text field focused", so the web pushes it over on `focusin`/`focusout`. It
suppresses keybinds; asserting it wrongly costs you your own hotkeys and nothing
else.

### Battery charge — moved

The client ran the drain timer and reported over `mica:server:battery:save`
every fifteen seconds, so a modified client asserted whatever charge it liked.
Validating that payload never changed what it was, so the event is **gone** and
the server ticks the number itself.

The authoritative version is smaller than the one it replaced: one interval and
a map, against a client timer plus a report path plus a clamp plus a write-skip
cache that existed to absorb four redundant writes a minute. Keyed by source, so
it only ticks while connected — which the server knows and the client merely
stopped doing. A push and a write happen when the **whole percent** moves,
roughly once a minute rather than every tick.

### Signal bars — moved

Zone evaluation happened on the client: the server pushed the zone list and each
client decided its own bars. That was defensible only while nothing read the
level, and it stopped being defensible the moment an app was going to degrade at
zero bars — a client that decides its own bars is a client that decides whether
it is in a dead zone.

The server polls now and the client is told a number. It no longer receives the
zone list at all, which is the load-bearing half: **a client that cannot see the
zones cannot decide it is outside one.**

The cost that originally pushed this to the client is real and is bounded twice.
An early-out means the ordinary case — no zones, full global signal — reads no
coordinates at all, and a push happens only when a player's whole-bar value
changes rather than every poll.

`mica:server:signal:rules` went with it, so the service has no raw `onNet`
handler left — one fewer entry point rather than one better guarded.

Done **before** any app reads the level, which was the point: the alternative
was shipping the first version of dead-zone degradation exploitable and fixing
it afterwards.

## Accepted risks

Accepted against the feature set at `0922a9b` (2026-08-29) — a risk below was
weighed against what existed then, and a service added afterward is not covered
by this list until someone re-weighs it.

- **Item metadata is attacker-controlled input, and a phone id comes out of it
  (MICA-281).** micaOS mints a phone id into the phone item's inventory metadata
  and reads it back to decide which phone a player is on. That storage belongs
  to the inventory resource, not to micaOS: a server running a modified
  inventory — or any other resource with write access to it — can put whatever
  it likes there, and a phone id is visible to anyone who has ever held that
  phone. Treated as a claim rather than a fact, in three places. `Repository`
  will not accept a phone id as an ownership predicate on its own: the citizenid
  the server resolved from the framework connection stays required, and the
  phone id only ever narrows a `WHERE` that already has an owner in it.
  `phone_id` is in both `NEVER_CLIENT_WRITABLE` and `NEVER_CLIENT_FILTERABLE`,
  so a payload can neither set one nor filter by one — the latter matters
  because "I once held this phone" would otherwise become a query for everything
  that phone owns. And a phone id in a shape micaOS would not have written is
  re-minted rather than trusted. What is **not** claimed: a phone id is not a
  secret, and nothing should ever be authorized by one alone.

  **MICA-282 made holding the item the thing that moves rows**, and it is worth
  saying exactly what is trusted. When `resolvePhone` finds an item in a
  player's inventory carrying a phone id whose `mica_phones` row names somebody
  else, every table with a `phone_id` column gets its `citizenid` rewritten to
  the holder (`Repository.transferPhoneRows`). The predicate on every read and
  write is unchanged — still `citizenid` **and** `phone_id` — so what is trusted
  is the inventory resource's own export saying "this player holds this item",
  which is the same trust the framework's `GetPlayer` is given. The residual
  risk is therefore the inventory's: a resource that can write item metadata can
  hand any phone, and everything on it, to any player. No client can; item
  metadata is server-authoritative in every inventory micaOS reads. What stays
  with the person regardless — money, listings, social accounts, authored
  messages — is listed in `docs/schema-and-services.md`, and a table is moved
  onto the phone only by declaring `deviceOwned` on it.

- **Owner-scoped actions reachable beyond what the UI offers.** A modified
  client can invoke any registered action against its own rows. Closing that
  entirely would mean an allowlist per action on top of the access axes that
  already express it. The mitigation is to register only what the app uses,
  which is now tested.
- **The rate limiter and `columnRules` bound less than a reader might assume.**
  `allow()` (`server/lib/rateLimit.ts`) is a fixed 60-second window per
  `(source, service, action)` — it does not bound how many _distinct_ actions a
  player fires inside that window, nor whether several land concurrently before
  any of them completes. `columnRules` bounds a single field's length, enum
  membership, and `int` range against the schema — it does not bound a request's
  total payload byte count, nor the sum across several writes. Neither gap is a
  defect in what these limiters were built to do; naming them here is so the doc
  does not overclaim by omission.
- **A modified client can attempt bank transfers up to the rate limit, bounded
  only by real balance and a resolvable recipient.** `Bank.ts`'s `sendMoney`
  caps a single transfer at `mica_bank_transfer_max` (default 50,000) and
  resolves the recipient from a phone number server-side, never a client-
  supplied citizenid — `transfer()` then re-verifies the sender's real balance
  against the framework's own money API. None of that is in question; what is
  unweighed is the _rate_: nothing caps the number of transfers a source can
  attempt per minute below the generic `(source, 'bank', 'sendMoney')` window,
  so a modified client's real ceiling is `transferMax() ×` however many
  `sendMoney` calls the 60-second window admits, not one transfer per window.
  The same applies to `Hodlr`/`HodlrMarket` trades, which share the convar and
  reasoning. No privilege escalation results — a transfer still needs a real
  balance and a real recipient — but the throughput bound is worth stating
  rather than left implicit.
- **`permissions` on a manifest refuse in-process; a `core: true` app is still
  not sandboxed from the shell** (§7). An undeclared hook throws
  `AppPermissionError` at component init; store-scope calls resolve by explicit
  app id or fall back to the in-process-only `system` host. A `core: false`
  add-on is different since `MICA-16` Step 4: it runs in a sandboxed
  `<iframe sandbox="allow-scripts" srcdoc>` with an opaque origin, no
  `allow-same-origin`, and no route to the shell but `postMessage`. Since
  MICA-196 that one route is held by four checks rather than one. The frame's
  Content-Security-Policy starts from `default-src 'none'` (`srcdoc.ts`); every
  inbound message must carry the `null` origin an `srcdoc` document has, so a
  guest that navigates itself to a real origin is refused, and a frame that
  loads a second document is torn down. The member table in
  `IframeHostServer.ts` is default-deny, with a totality test beside
  `permissions.test.ts`. A service is reachable only if the manifest's
  `services` names it, never by an id prefix. And one frame is capped at 600
  requests per ten seconds, 200 live subscriptions and 128 facet instances,
  refused rather than torn down. The **shell** re-checks every permission
  against `HOOK_OF_FACET` before answering a call — the frame's own check is a
  courtesy, not the boundary. `sdk/permissions.ts` maps every host hook to a
  permission; `permissions.test.ts` fails the build where a manifest understates
  its imports. **Consent is the shell's own record, not the manifest**
  (MICA-201). It used to be neither: MICA-196 compared an update's permissions
  against the _installed manifest_, so the manifest was its own authorization
  and anything able to write one — a modified Store, or any core path that
  installs a catalog entry — widened what an add-on could reach with nobody
  asked. The set the player accepted now lives in
  `web/src/shell/state/addOnGrants.ts`, keyed by add-on id and persisted per
  character alongside the install list itself; it is written **only** through
  `appRegistryWrite`'s `recordConsent`, a member no add-on can name
  (`FACET_MEMBERS.appRegistryWrite` is empty, so a raw `postMessage` gets "core
  only"), and it is read by `IframeHostServer` before every call. A manifest
  permission with no matching grant is refused with the same
  `AppPermissionError` an undeclared one gets, so an update that adds a
  permission does nothing at all until the player answers the Store's prompt —
  and the Store now compares against that grant rather than against a manifest
  it could have written. Uninstalling revokes the grant. One exception, and it
  is narrow: an add-on that ships **in this repository** (`bundledAddOns`) is
  vouched for by the build, so where no grant was ever recorded its manifest's
  declared permissions stand as the grant and are recorded at that open
  (`grantFor` in `registry.ts`) — a deep link (`/?app=blabber`) or a dev
  registration reaches a bundled add-on with no install sheet and no player to
  ask. A remote add-on is never in that list and keeps the strict rule. Two
  limits worth stating: an add-on installed before this landed adopts its
  installed manifest's permissions once, at the next boot, since there is nobody
  to ask at rehydration time; and this is storage the shell owns, not storage it
  can prove untampered — a player with the console open can edit it exactly as
  they can edit the install list beside it. What it stops is a _code_ path
  standing in for a player's answer.
- **An add-on's code is trusted at build time, not at run time.** The Store
  installs a bundle that runs in that sandboxed frame, not in the shell's own
  context; the shell hash-verifies the bundle text it was handed before booting
  it. §2.9 is what stands behind server-side actions either way — the server
  does not care which app is asking.
- **Where the bytes are fetched from is checked, and checked again on update.**
  `isTrustedRemoteUrl` (`web/src/shell/state/remoteAppSecurity.ts`) requires
  HTTPS plus a hostname on an operator-configured allowlist, empty by default —
  nothing installs from anywhere until an operator opts a catalog host in. It
  exempts `data:` URLs, because `installFromCatalog` only ever builds one
  internally from bytes it has already hash-verified; that exemption is not safe
  to hand untrusted input directly, so the caller is responsible for rejecting a
  `data:` URL first — `nuiMessages.ts`'s `installApp` handler does exactly that,
  refusing a `data:` `bundleUrl` at the NUI boundary before `isTrustedRemoteUrl`
  ever sees it. An update is not exempt from any of this either: `appUpdates.ts`
  re-fetches the bundle and re-verifies it against the catalog entry's **fresh**
  `sha256`, the same check a first install runs, rather than trusting a
  previously-verified hash to still apply.
- **An add-on's outbound network is a declared per-app allowlist, not "any host"
  (MICA-24).** Before this, the sandboxed frame had no Content-Security-Policy
  at all: an opaque origin with `allow-scripts` can still `fetch()` any URL, so
  a compromised bundle (or a supply-chain compromise inside a legitimate one)
  could exfiltrate to, or beacon, anywhere on the internet with nothing in place
  to stop it. `AppManifest.networkHosts` (`sdk/manifest.ts`) is the list of
  exact `https://` origins an add-on may reach; `srcdoc.ts` turns it into the
  frame's `connect-src`, and no hosts means `connect-src 'none'` — outbound
  `fetch()` blocked entirely, which is the default every add-on gets unless it
  declares otherwise. Declaring a host without also declaring
  `requiresNetwork: true` is refused by `defineApp`, so an app cannot get real
  network egress by accident or through a field nobody meant to combine. Since
  MICA-196 the policy starts from `default-src 'none'` and names each escape
  hatch: `connect-src` is `networkHosts` or `'none'`; `img-src`, `media-src` and
  `font-src` are `https: data: blob:`; `frame-src`, `child-src`, `form-action`
  and `base-uri` are `'none'`; `script-src` and `style-src` keep exactly the
  reach they had, because Svelte's runtime-injected `<style>` and the inlined
  module script need it. **One channel is left open on purpose and is an
  accepted risk: `img-src https:` still lets `new Image().src` beacon a payload
  to any https host.** Scoping it to `networkHosts` would break every add-on
  that renders a photo or avatar from an https URL the phone handed it at
  runtime (`sdk/ui/MediaThumb.svelte` accepts one), and that is a
  published-contract change to make deliberately rather than inside a hardening
  pass — MICA-202 holds it. `child-src 'none'` also stops Web Workers, and no
  subresource directive admits a plaintext scheme.
- **Message and DM bodies are readable by whoever operates the server, and that
  is inherent to what a FiveM resource is, not a defect in micaOS (MICA-70).** A
  message lands in the operator's own MySQL database as plaintext
  (`server/services/Messages.ts` declares `message` as the table's
  `reportable.previewColumn`, which is what lets an admin reviewing a report
  read the body being reported) and the same operator runs the server console —
  nothing a resource does can keep its own host from reading its own database.
  End-to-end encryption was considered and rejected as the wrong tool here, for
  three reasons rather than one: micaOS ships the client as part of the
  resource, so there is no independently distributed client whose code an
  operator cannot alter — an operator controlling the code that encrypts defeats
  E2EE's entire guarantee; there is nowhere durable to hold a private key, since
  CEF's browser storage is per-machine and does not survive a reinstall or a new
  PC; and E2EE would break the moderation/reports system above, which depends on
  an admin being able to read a reported message's body to act on it. This
  round's answer is disclosure and accountability, not secrecy: a privacy notice
  on first run and from Settings says plainly that message content is readable
  by the server operator, and an admin reading a message's body is now written
  to the audit ledger (`server/lib/AuditLogger.ts`) so _that_ it was read is on
  the record, even though the underlying database access it is auditing never
  was and structurally cannot be prevented from the resource side. Three things
  this round explicitly does **not** do, so nobody mistakes this slice for the
  whole of MICA-70: no encryption at rest — a server owner with database access
  still reads plaintext regardless of the audit log — no retention limit, so
  messages are kept indefinitely by default, and no player-facing export or
  delete of their own message history. Those are deferred as separate follow-up
  work.

---

## What the test suite cannot tell you

Every test here drives the **server** directly. That proves the server refuses —
not that the client is the only thing asking. Confirming the NUI surface needs
`nui_devTools` in game and a look at what `RegisterNuiCallbackType` actually
registered.

Nothing in the automated suite exercises a modified client, a real CEF instance,
or another resource calling an export. Those are the three places this
document's assumptions actually get tested.
