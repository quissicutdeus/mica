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

**Twelve, across seven files**, and they fall into two categories that need
different things said about them. They sit outside `ServiceEndpoint` because
they answer fire-and-forget events with no callback id, so they cannot go
through it.

This census used to read "six, in `Phone.ts` and `Battery.ts`", and it was wrong
in both directions: three mica-named handlers had been added since it was
written, and the **framework-named** category below had no row at all — which is
how an inventory that reads exhaustive never mentioned it. Count from the tree,
not from this page:

```sh
grep -rn "onNet(" server --include="*.ts" | grep -v __tests__
```

**That prints fourteen lines for twelve handlers.** Two of them are not entry
points: `ServiceEndpoint.ts`'s generic registrar, which is the machinery behind
category 1 of this document, and the worked example in `netGuard.ts`'s doc
comment.

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

The tables below name a **file** per handler and no line. They used to carry
one, and nothing checked it: by the time MICA-285 looked, nine of the eleven
were wrong, one by more than three hundred lines. A line number that nothing
holds true reads as precision and is worse than none, so the choice was to gate
them or drop them, and gating lost — every edit that moves a handler would fail
a suite until this page was retyped, for a number a reader never needs, because
`grep -n` on the event name finds the handler in one step. The census suite
asserts that no row here carries a `:<digits>` suffix, so a line cannot creep
back in with a new row.

#### mica-named — nine, every one guarded

| Event                                | Handler                        |
| ------------------------------------ | ------------------------------ |
| `mica:server:phone:start`            | `server/services/Phone.ts`     |
| `mica:server:phone:answer`           | `server/services/Phone.ts`     |
| `mica:server:phone:end`              | `server/services/Phone.ts`     |
| `mica:server:phone:simulateIncoming` | `server/services/Phone.ts`     |
| `mica:server:admin:setBattery`       | `server/services/Battery.ts`   |
| `mica:server:battery:load`           | `server/services/Battery.ts`   |
| `mica:server:contacts:share`         | `server/services/Contacts.ts`  |
| `mica:server:shell:setOpen`          | `server/lib/PhoneOpenState.ts` |
| `mica:server:shell:checkDeviceItem`  | `server/lib/deviceItem.ts`     |

`guardNetEvent` in `server/lib/netGuard.ts` is the preamble for all nine,
applying the same three checks in the same order the endpoint uses: rate limit
first, then the declared input schema, then the authenticated player lookup —
`getPlayer` walks the framework's player table and neither a flood nor a
malformed packet should make the server pay for that. Refused **silently**,
because there is nobody waiting on a reply to be told; `ServiceEndpoint` answers
its refusals only because `fetchNui` would otherwise hang for fifteen seconds.

**Every raw handler declares its input once, as a tuple schema, and the guard
parses it before the body runs (MICA-210).** MICA-195 put a contract in front of
every `registerEvent` action; these events carry positional scalars rather than
a keyed payload, so each one declares its arguments with `s.tuple([...])` from
`shared/schema.ts` — `[phoneNumber]` for `phone:start`, `[batteryLevel]` for
`admin:setBattery`, a stripped-down `Contact` card for `contacts:share`, a
boolean-or-`{ device, open }` union for `shell:setOpen` (whose `device` is
client-asserted display state exactly as the open flag already is: it names
which screen the player says is up, and moves no lock, item or identity), and
`noInput` for the four that take nothing — and passes it to `guardNetEvent`,
which will not compile without one. The schema is the only place a handler's
shape is written: `phoneNumber` and `batteryLevel` are the shared elements and
the rest sit beside their handler, so the hand-rolled parsers each one used to
keep are gone. The second is still worth naming: `Number(null)` is `0` and
`Number('')` is `0`, so a client sending nothing at all used to produce a valid
"0% battery" rather than a refusal, and `s.number()` refuses both before the
clamp runs.

`netGuardCensus.test.ts` holds this the same way it holds the counts: from the
tree, it refuses any raw handler whose body never calls `guardNetEvent` (or
`loadedPlayerSource`, which does), refuses any call to it whose third argument
is not a name declared with `s.tuple(`, and counts the call sites against the
handlers so a regex matching nothing cannot pass. `netGuard.test.ts` drives each
of the five shapes with a malformed argument list and a well-formed one. The one
handler outside the mechanism is the framework-named
`qb-phone:server:sendNewMail` below, which parses inline; the census names it as
the single exemption, so a second one is an edit to that list rather than a
quiet omission.

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

#### Framework-named — three, and this is the category that was missing

| Event                          | Handler                       |
| ------------------------------ | ----------------------------- |
| `QBCore:Server:OnPlayerLoaded` | `server/lib/shell.ts`         |
| `qb-phone:server:sendNewMail`  | `server/lib/qbPhoneCompat.ts` |
| `pma-voice:setPlayerCall`      | `server/services/Phone.ts`    |

The second is deliberate (MICA-222): qb scripts fire it with the player as
`source` to mail that player, and answering it unmodified is the point. It can
do nothing but mail the source, it applies the same two checks inline -- `allow`
first, `getPlayer` second -- and its sibling `sendNewMailToOffline`, which names
a citizenid, is registered with `on` and is not an entry point at all. qb-phone
had that one as a net event; the hole did not come across.

The third is pma-voice's own event, not a framework's, and micaOS listens to it
only to undo it (MICA-341). pma-voice adds any client that sends it to any call
channel, with no check (`server/module/phone.lua` in pma-voice); a call's id is
its channel. The server now places both parties itself, and this handler takes
back out anybody who lands in a live call's channel without being placed there.
It reads the channel from pma-voice's state bag, never from the payload. It
takes no `guardNetEvent` preamble on purpose, since a rate limit that stopped
answering would leave a looping client in the call. **It narrows the hole to
about one server tick per forged join; it does not close it.** Only a check in
pma-voice itself can, and that is upstream's to add.

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
is why the player-loaded flow contributes one row here and not two.

Vanilla `qb-core` was not available to check. If it ever does fire this name
locally, that arrives with `source` 0 and is refused, and the `on()` twin is
where such a core belongs.

**ESX support added a fourth player-loaded handler and no fourth entry point,
and the distinction is the whole reason this section counts what it counts.**
`server/lib/shell.ts` listens for `esx:playerLoaded`, and it is registered with
`on`, not `onNet`. es_extended raises that name server-side and locally —
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

**The unload events are the same category and add no row to the table.**
`server/lib/shell.ts` (`PLAYER_UNLOADED_EVENTS`) listens for
`QBCore:Server:OnPlayerUnload` on qbx and qb-core and `esx:playerLogout` on ESX
Legacy (MICA-382), so that a multicharacter logout, for which FiveM fires no
`playerDropped`, ends the call and stops addressing the character who left. Both
are registered with `on` alone, for the reason the paragraphs above give: both
frameworks raise them in-process, and network-safety is per-resource, so a
client emitting either name reaches nothing in micaOS. There is deliberately no
`onNet` twin. It would be the one change that made this dangerous, since it
would let any client name another player's server id and have the server end
their call and stop their pushes.

The payload is the identity here, as it is for `QBCore:Server:PlayerLoaded`, but
it is still only believed as a positive integer (`unloadedSource`), which is
what a server id is; anything else is ignored. There is no `guardNetEvent`
preamble because there is no network caller to rate-limit.

What a forged one could do is bounded by who can raise it: only a resource on
the server, which is already trusted with the framework's own events. Raised
with a connected player's id, it ends that player's call for both parties (the
call-log row is written as for any ended call), switches off their speakerphone
and music broadcast, and stops pushes addressed to their character until the
next load on that id. It reads and writes no rows, and it does not touch their
source locks or signal override, which wait for a different character's load.

#### Bridge-named — one per optional bridge, outside this resource

The lb-phone and NPWD bridges (MICA-232, `bridges/`) are separate resources an
owner may copy out and ensure, and each registers one net event of its own:
`lb-phone:bridge:createCall` or `npwd:bridge:createCall`, which their client
halves fire so a client script's `CreateCall` / `startPhoneCall` can reach the
server-only `CreateCall` export. The handler dials as `source` and nobody else,
takes a string of at most 20 characters, and drops a second call inside two
seconds. It grants nothing new: `CreateCall` runs the same `placeCall` as
`mica:server:phone:start`, which every client can already fire. Neither name
starts with `mica:`, so `eventNames.test.ts` does not see them;
`server/__tests__/bridges.test.ts` covers the handler instead.

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
limiter in `rateLimit.ts` cannot see: an export has no source. `PostToDarkChat`
allows 30 a minute (MICA-254), for the same reason: every line it writes is
pushed to each live member of a channel. Nothing else at this boundary is
limited, deliberately: a hostile resource is out of scope, and a bug that calls
`SendNotification` in a loop costs a notification row per call where a text
costs a thread, a participant and a push.

**`RegisterService` makes another resource answer player calls (MICA-308)**, and
that resource is trusted the same way as any other here. What micaOS still
guarantees is the shape of what reaches it. Each add-on id gets a real
`ServiceEndpoint`, so a player's call passes the same limiter, app switch,
player resolution and strict parse against the declared fields as a core action
does. The handler receives `(citizenid, input, source)` with `citizenid`
resolved on the server. Whose rows those are is the resource's job, as the
README says. A resource holds only ids it registered, never a built-in service
or app id. **A resource's holdings are released only when it is actually
stopping** (`server/lib/resourceStop.ts`): `onResourceStop` is an ordinary event
any script can fire, and before this, firing it in another resource's name
released that resource's add-on services, `RegisterNumber` lines and invoice
callbacks for the caller to take. That is the buggy-or-careless neighbour this
section exists for, not the hostile one it cannot stop.

### 4. The integration door, which is not an entry point on a live server

The in-server suite (MICA-302) runs with no player connected, and every service
action sits behind `ServiceEndpoint`, which resolves a connected player and
replies to that player's source. So with `mica_integration` set to `1` **at
resource start**, and never otherwise, `server/lib/integrationDoor.ts` registers
three local events — `mica:server:integration:player`, `:invoke` and `:pushes` —
that seed a synthetic player with an in-memory bank ledger, run a service action
for it through the very same dispatch the net event uses (contract parse,
limiter, phone gate, `clientWritable` reduction, handler), and hand back the
pushes it would have received (MICA-397).

What makes it not a hole: the events are registered with `on()`, never `onNet`,
and FXServer refuses a client's `TriggerServerEvent` for an event that was not
registered as a net event; there is no export and no NUI route; the convar is
read once at start, so a live `set` opens nothing; and with the convar unset the
module registers nothing at all, which
`server/__tests__/integrationDoor.test.ts` and `reachability.test.ts` hold.

The synthetic players do answer `FrameworkBridge`, within two bounds that hold
on every call (`installSyntheticPlayers`, `server/lib/FrameworkBridge.ts`).
`getPlayer` consults them only for a source at or below `SYNTHETIC_SOURCE_MAX`
(`-1000000`); FiveM's server ids are positive, `-1` is the broadcast target, and
the Phone's line pseudo-sources count down from `-2` by one per call, so no
connected player's source and no line ever reaches them. `getSourcesByCitizenId`
consults them only for a citizenid the registry and its walk did not find, so a
connected character always answers with their real source — and a citizen the
registry has online is refused both at seed and on every `invoke`, so a
synthetic player is never a connected character's twin. The install itself
throws unless the convar was `1` at start, and on a second install.
`server/__tests__/FrameworkBridge.test.ts` holds each bound. That is what lets a
handler that asks the bridge again after an await (the MICA-336 guards in
Messages and PhoneNumbers) run for a synthetic player, and what lets the door
capture every `emitNet` aimed at a synthetic source — app-event pushes and raw
events alike — while an emit to a positive source or to `-1` passes through
untouched.

The door can also seed a synthetic _admin_ (`{ admin: true }` on `:player`,
MICA-386's scenarios). `isAdmin` in `server/services/Admin.ts` answers a source
at or below `SYNTHETIC_SOURCE_MAX` from `FrameworkBridge.isSyntheticAdmin`
alone, never from an ace, and that answers true only while a resolver is
installed, the source holds a door player, and the door flagged it; a positive
source never reaches the flag and stays on the ace path. So on a harness server
another resource can run the admin-gated `ServiceEndpoint` actions — the Reports
queue, history, resolve and reopen, and `admin:check` — as a seeded admin. Every
command and raw `onNet` admin gate is not reachable through the door at all, and
with the convar unset at start nothing can be installed.
`server/__tests__/admin.test.ts` holds the routing and `FrameworkBridge.test.ts`
the three conditions.

A server owner has one rule to keep: do not set `mica_integration` on a server
players join. It is in the README's convar table with exactly that warning.

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

## Message bodies at rest

**This protects a stolen database dump. It does not protect anyone from the
server's operator, and it is not end-to-end encryption.** The operator holds the
key and runs the code that uses it; a server that wants to read its players'
messages can. What it stops is the far commoner leak: a FiveM database backup
left on a share, pasted into a support thread, or sold, read by someone who
never had the server (MICA-165).

With `mica_content_key_file` set, thirty-three columns are sealed with
AES-256-GCM in `server/lib/contentCipher.ts` before they reach SQL, and opened
after every read. Five came with MICA-165, the bodies of conversations; fifteen
more came with MICA-431, a phone's own private content; thirteen more with
MICA-432, the names, numbers and codes that identify who and what:

| Column                                            | What it holds                                                  | Bound to, besides the table and column                     |
| ------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| `mica_messages.message`                           | A text message                                                 | `citizenid`, `conversation_id`                             |
| `mica_blabber_dms.body`                           | A direct message, in any social app                            | `citizenid`, `from_account`, `to_account`                  |
| `mica_mail.content`                               | An email's body                                                | `citizenid`; a mailbox is its own thread                   |
| `mica_darkchat_messages.body`                     | A Dark Chat line                                               | `citizenid`, `channel_id`                                  |
| `mica_darkchat_messages.bot_alias`                | The alias an export's line is signed as                        | `citizenid`, `channel_id`                                  |
| `mica_reports.target_preview`                     | The snapshot of a reported message or DM                       | `citizenid`, `target_table`, `target_id`                   |
| `mica_reports.note`                               | The reporter's own note                                        | `citizenid`, `target_table`, `target_id`                   |
| `mica_notes.title`, `.content`                    | A note                                                         | the phone, `device_id`                                     |
| `mica_contacts.firstname`, `.lastname`, `.email`  | A contact's name and email                                     | the phone, `device_id`                                     |
| `mica_phone_call_log.number`                      | The number of a call                                           | the phone, `device_id`                                     |
| `mica_places.name`, `.street_label`               | A saved place                                                  | the phone, `device_id`                                     |
| `mica_media.data`, `.thumbnail`, `.alt_text`      | A photo, its thumbnail and alt text                            | the phone, `device_id`                                     |
| `mica_mail.subject`, `.sender`, `.sender_address` | An email's subject and sender                                  | `citizenid`; a mailbox is its own thread                   |
| `mica_invoices.memo`, `.from_label`               | An invoice's memo and who it is from                           | `citizenid`                                                |
| `mica_contacts.phone`, `.avatar`                  | A contact's number and picture                                 | the phone, `device_id` (the number also has a blind index) |
| `mica_places.position`                            | A saved place's x, y and z, merged into one sealed JSON column | the phone, `device_id`                                     |
| `mica_messages_conversations.name`                | A thread's name                                                | the thread's `seal_key`                                    |
| `mica_darkchat.name`, `.code`                     | A channel's name and join code                                 | the channel's `seal_key` (the code also has a blind index) |
| `mica_darkchat_members.alias`, `.handle`          | A member's alias and handle                                    | `citizenid`, `channel_id` (both also have a blind index)   |
| `mica_notifications.title`, `.body`               | A notification                                                 | the phone, `device_id`                                     |

**A phone's data is bound to the phone, not the character** (MICA-431). A value
on a `deviceOwned` table is sealed under its own domain, with the `device_id`
where a character would be, and nothing rewrites a `device_id`, so the value
opens on that phone and on no other: a ciphertext copied onto a row of another
device does not open, even one of the same character's, such as their tablet's.
MICA-431 chose this while a handover rewrote `citizenid` on every row of a
phone, which a value bound to the character would not have survived (the new
holder would have found a phone full of 🔒). MICA-436 removed the handover and
MICA-438 made the phone the character's one phone, so that reason is gone; the
binding stays for what it still does. A row with no phone, one written before
phones had rows of their own, binds to its own character, tagged so it can never
be mistaken for a device id. Values sealed before MICA-431 open as they did,
since a character-bound value's bytes did not change.

Encrypting inside the application, not with MySQL's `AES_ENCRYPT`, is the whole
point: that would put the key in every statement, so in the query log and the
process list, beside the data it protects. For the same reason the key is never
a convar. `mica_content_key_file` names a **file**, and `server.cfg` is the file
most often pasted, shared and committed next to the dump. **FXServer decides
where that file can be:** a resource may read only files inside a resource
folder, so the key lives in a resource of its own, `mica-keys` — ideally as a
symlink there to a file kept outside `server-data`, which FXServer does follow
(MICA-303). The server warns at boot when the key sits inside `mica`'s own
folder (an update deletes it), when its real path is inside `server-data` (a
backup of `server-data` carries it), or when it is readable by anyone but its
owner, and it refuses a key it cannot read with the rule spelled out. It cannot
know where your backups go; keeping the key out of them is the one step only you
can take.

**The binding is not the row id, on purpose.** The ticket asked for it, but a
row's id does not exist until the insert that stores the ciphertext, so binding
it would mean insert-then-update on every write, an empty row left behind when
the second statement fails, and no way to seal inside the importer's batched
transactions. The binding still refuses a ciphertext copied to another player,
another conversation or another column. What it gives up is swapping two of one
player's messages inside one thread, which someone holding a read-only dump
cannot do. `defineService` refuses an `encryptionScope` column that is
client-writable, because a scope column rewritten after the fact would strand
the ciphertext bound to it.

What stays readable in a dump, deliberately: who talked to whom and when, Blabs
(public posts), attachments, and every other table. Names, numbers, codes, mail
subjects and senders, invoice memos, saved places, photos and notification text
are no longer among them. A mail's subject and sender used to be left readable
as system-written; MICA-432 reversed that, since a subject says what a message
is about and a sender says who it came from. Home search (MICA-248) filters what
the phone already has, and retention (MICA-167) and the purges hide by age and
status without reading a body.

Six edges, each chosen rather than overlooked:

- **No key is legal**, and stores plaintext as micaOS always did, with a warning
  every boot. But the first successful seal writes a marker into
  `mica_schema_migrations`, and from then on a missing key **refuses** writes to
  these columns rather than quietly storing plaintext beside ciphertext. A key
  file that is set but unusable is refused the same way, never read as "no key".
- **A body that will not open reads as 🔒**, logged once per row, instead of an
  error. One row sealed under a lost key must not take its thread down with it.
- **Rows written before the key are not sealed until
  `micacrypt backfill --apply` runs** (`docs/in-game-commands.md`). Readers
  accept both forms in the meantime. Dumps, binlogs and backups taken before the
  backfill are plaintext and stay that way; encrypting the live table does
  nothing for a copy that already left. A persisted DM notification no longer
  keeps the first 120 characters of the message; the backfill blanks the ones
  written before, and does so before sealing, so a preview is never kept sealed.
  Migration 0013 widens the columns the new values need; `micaschema apply` runs
  it, and it copies the contacts, call log and Dark Chat tables, so allow for
  the time on a large one.
- **A note or other `text` that is too long to seal stays plaintext.** A sealed
  value is longer than the text in it, and a `text` column has a fixed width, so
  its plaintext bound drops to the most characters whose sealed form fits: about
  12,276 for a note. The Notes editor caps content at that number and the title
  at 255 characters (`web/src/apps/notes/limits.ts`), so the player sees the
  limit while typing, and the server refuses anything longer. A longer note
  already in the table is left as it is. `micacrypt status` counts it as too
  long to seal, and `backfill` reports it rather than truncating it.
- **Media bytes are sealed as ASCII.** A photo is base64, one byte a character,
  and bounding it at utf8mb4's worst case of four would refuse a photo that a
  `mediumtext` holds sealed with room to spare. A write with any other character
  is refused, so the bound cannot be outrun. That includes media a script gives
  through the `AddMedia` export or `addForPlayer`: it must be ASCII-only, so a
  `data:` URI with non-ASCII bytes, such as a UTF-8 SVG, is refused.
- **Text that begins with the sealed form's own prefix, `$mc1$`.** With a key it
  is sealed like any other text and reads back exactly. Without one it would be
  stored bare and then read as a sealed value, so a player's own message or DM
  is refused with a message saying why, while a report's snapshot, a text sent
  through `SendMessage` and mail sent through `SendSystemEmail` get a zero-width
  space in front instead, so filing a report or relaying another resource's text
  never fails on it. A row stored bare with that prefix before micaOS encrypted
  anything reads as 🔒, and `micacrypt status` counts it as unreadable.

**Lose the key and every body sealed with it is gone.** Back the key file up
somewhere that is not the database backup.

**Back the key up as a step of turning encryption on, not as an afterthought.**
Since MICA-428 and MICA-429 nothing is deleted: an erased, expired or taken-down
row stays in the database as evidence, and since MICA-431 and MICA-432 most of
what those rows hold is sealed under this key, with the blind indexes and sealed
version snapshots beside it. Evidence retention therefore depends on the key
file as much as on the database: lose the file and every kept row is unreadable
for good, which is the opposite of what keeping it was for. A database backup
without its key file is just as unreadable. Keep a copy of the whole file, every
line, outside `server-data`, outside the repo, and not in the same place as the
dump, so that neither leak gives up the other. Rotating a key and then removing
its old line has the same effect on every row still under it; `micacrypt status`
says when none are ([`docs/in-game-commands.md`](in-game-commands.md)).

**A thread or a channel is bound to its own key** (MICA-432). A Dark Chat
channel or a Messages thread is not the character's alone: its owner can change,
and `citizenid` is the wrong thing to bind a name or a join code to. Such a
table (`encryptionBinding: 'row'`) draws a random `seal_key` for each row when
it is written, never rewrites it, and binds its sealed values to it, under a
domain of their own. A row written before its table had the column is given one
by migration 0014 before anything is sealed; a value is never sealed to an empty
key, which every such row would share. Child tables are sealed with their own
scope: a Dark Chat member's alias and handle are bound to the member and the
channel (`channel_id`), as a Dark Chat line is.

### Blind indexes: looking up what you cannot read

A contact's number is unique per phone, a Dark Chat join code is how a channel
is found, and an alias and a handle are unique within a channel. Sealing the
value breaks each of those lookups, since every seal of the same text differs. A
**blind index** keeps them: a column beside the sealed value holding an HMAC of
it, which `WHERE` and `UNIQUE` can use and which reveals nothing by itself.

- **The key is derived, and separate.** It is HMAC-SHA-256 under an index key
  derived from the content key for the purpose `'micaOS blind index v1'`
  (`server/lib/contentCipher.ts`), so it is not the sealing key and not the log
  salt (`who()`). A leaked index does not open a sealed value, and the sealing
  key is never used as a digest key.
- **The form is `<kid>$<64 hex>`**, the key id then the digest. It is scoped
  like the AAD: the value is digested together with the columns it is unique
  within (the phone's `device_id` for a contact, the `channel_id` for an alias),
  so the same number on two phones gives two unrelated indexes. A dump cannot
  show that two players saved the same number.
- **With no key the index is `plain:<normalized>`.** It holds what the plaintext
  lookup column held before, no more, and cannot be mistaken for a keyed one. It
  **fails closed exactly as sealing does**: once anything has been sealed, a
  missing or unusable key file refuses the write and the lookup rather than
  writing `plain:` beside keyed rows or missing a row. A keyed index records the
  enabled marker first, as a seal does.
- **A lookup tries every loaded key id plus `plain:`**, so a row is found
  whichever key indexed it, mid-rotation included. `micacrypt backfill --apply`
  re-indexes to the active key, and `micacrypt status` counts index rows not on
  it. Remove an old key line only when that count is zero.
- **What a number's uniqueness compares** is what the column's collation did
  before it was sealed: case-blind, trailing spaces ignored. `555-0100` and
  `5550100` are still two numbers, as the player typed them
  (`server/lib/contactNumbers.ts`).
- **An add-on can no longer filter on `contacts.phone`.** A client cannot filter
  over a sealed value, so the field is not `clientFilterable`; the address-book
  finds a contact through the server.

**An accepted race.** Between enabling a key, or rotating one, and the backfill
finishing, some rows carry a `plain:` or older index. A lookup finds them, but a
uniqueness check compares indexes, so a duplicate contact number written in that
window under the new key can slip past one still indexed the old way. The
backfill reports it when it re-indexes. It lasts until
`micacrypt backfill --apply` has run.

## Dark Chat: anonymous to players, not to staff

Dark Chat (MICA-254) hides who is who from the other members of a channel. It
does not hide anything from the server or from its staff, and it is not meant
to.

**What a member sees** is the channel's name, the aliases of its live members,
and each message with its alias, its time and whether a script posted it. The
owner sees the join code as well, and only the owner learns that they own the
channel. No projection, push or error carries a citizenid, a phone number, an
account handle, a member's join time, who owns the channel, or which other
channels a member is in. A member is named to others by a random handle, never
by its row id, which is a global sequence and would rank members by when they
joined, mark the owner as the earliest, and tie together two aliases one player
took in two channels one after the other. Membership is checked on the server
for every read and write through `access.membership`, and a member who leaves or
is removed stops reading at once, because their row's `left_at` is set. Blocks
do not apply inside a channel: honouring one would tell the blocked player who
blocked them.

**What staff see.** A report from inside a channel records what every report
does, the reporter's citizenid and the reported message's author citizenid
(`target_author`), plus the reporter's alias in that channel (`reporter_label`),
and Admin shows the alias, and on the tablet the author's citizenid. A report
forwarded to Discord names the reporter's citizenid, as every forwarded report
does. The excerpt a report stores outlives the message, as it does for every
report. Staff cannot read a channel's history through Admin, only the reported
message. A line a script posted cannot be reported: its row is owned by the
channel's owner, so a report would name the owner as its author.

**What the database holds.** Every member row and message row carries its
player's citizenid, because ownership is how every micaOS table is authorized
and swept. A message body is sealed under the content key when one is set
(above), bound to its channel, and so are the channel's name and join code, a
member's alias and handle, and an export's alias, so a dump shows a table of
ciphertext and the citizenid beside it, not who is called what or how to join.
The join code and the alias and handle are found through blind indexes (above).
A message is hidden once it is past `mica_darkchat_retention` (24 hours by
default, with no off switch): a sweep moves it from `active` to `expired` and
keeps the row (MICA-428), except one under an open report, which waits for the
report to be resolved, and one staff have taken down, which waits for as long as
it is `moderated`. Nothing about a channel is swept any more. A member who has
left or been removed, and a deleted channel, are already hidden and their rows
stay, so the row that ties a member's alias to their citizenid is kept for good,
and so is a `removed` member's, which is what stops them joining again. Every
read filters to the window and to live statuses, so an expired line is never
shown, and the player data export filters the same way. The export leaves out
the join code, which is a credential for the channel, not the player's data.

**Accepted.** Anyone with database access can tie an alias to a player while
that player, in a channel they are in or have left, for as long as the row is
kept, which since MICA-428 is for good: nothing deletes a member row, so the
alias-to-character map outlives the window. The failed-join limit (ten wrong
codes in ten minutes per character) lives in memory, so a server restart resets
it; a code is eight characters from a 31-character alphabet, far beyond what
that buys. When a character is deleted by the framework rather than through
Settings, a channel it owned keeps a dead owner: its members still talk, but
nobody can read or replace the code or remove a member. Membership follows the
character, not the phone, so a phone item handed to someone else carries no
channels.

## Spark: who liked whom is the secret

Spark (MICA-255) is a dating add-on on the accounts layer. Its anonymity problem
is different from Dark Chat's: players show their face on purpose, and what must
not leak is the swiping. Nobody learns who liked them until it is mutual. The
first like answers nothing and pushes nothing; only the second like creates the
match, and that one insert tells both sides. There is no count of likes
anywhere, the deck is ordered by profile id and never by the other person's
swipes, and a swipe on a profile that is yours, blocked, deleted or missing gets
the same generic refusal. Swipes and matches carry no owner, so a player's data
export shows neither who liked them nor whom they liked, as Blabber's likes
already do not.

A Spark account is one per character and unlisted: `search`, `follow`, the
follower lists and the public account read never show it, so a dating profile
cannot be found from Blabber or Glimpse. A card carries the Spark account's id
and display name and nothing from any other app. A profile photo is named by its
Spark row, not the gallery id, which is global and would tie the profile to a
Glimpse post of the same picture. Messages after a match are the shared `dms`
service under Spark's policy, which allows a thread only while a match exists
and neither side has blocked the other; unmatch, block and profile delete each
hide the thread, except one under an open report, which is kept whole, or
holding a row staff have taken down, which stays as evidence. The notification
says only "New message", because it shows on the lock screen.

**What staff see.** A reported profile or message carries the reporter's and the
author's citizenid, as every report does, and Admin previews the bio or the
message. Staff do not see swipes or matches.

**Accepted.** The age is in character and entered by the player; the server
refuses anything under 18 and can verify nothing more. Because an account is
never deleted, a deleted profile leaves its handle behind, scrubbed of its name,
bio and avatar; a new profile reuses it, which is what keeps blocks against a
player in force across a deleted-and-recreated profile. An unmatch is not a
block: it holds only while both profiles exist, so a player who deletes and
remakes their profile can appear in the other's deck again, and that
reappearance tells them the profile was remade. Only a block survives a remade
profile.

## Casino: the crash point is the secret

Casino (MICA-82) is a gambling add-on that moves bank cash, so it has the Bank
and Hodlr problems — a modified client can emit any action with any payload —
and one of its own: a Crash round's outcome exists before the player acts, and
the whole game is that they do not know it. Every outcome is drawn on the server
from `node:crypto`. A roulette spin is decided after the stake is debited and
before any row exists, and the answer carries the number and the payout
together, so there is nothing to read early. A Crash round stores its point in
`mica_casino_rounds.crash_point`, a `private` column that no read projects: the
player learns it when the round settles, from the cash-out answer or the `crash`
push, and `history` never shows it for a round still in play. The multiplier a
cash-out earns is computed from the server's clock and the moment the server
started the round, never from anything the client sends, so a client that stops
its animation or lies about elapsed time changes nothing. The timer that busts
the round and a cash-out that races it both settle through one conditional
`UPDATE` on the active state, so a round pays or busts once.

Stakes follow the MICA-134 rule: the balance check and the debit sit in one
synchronous span, the row is written after the money has moved, and a failed
write refunds and logs rather than keeping the stake. One live Crash round per
citizen is a unique key on a generated column, not a read-then-check, so two
`crashStart`s racing past the read cannot both insert. A player's data export
includes their settled rounds — game, stake, payout, multiplier, the roulette
result and, once the round is over, the crash point — and leaves out a round
still in play altogether, since any row for it would carry the point.

**Accepted.** A Crash round live when the resource stops is settled as lost at
the next start, stake included: the timer that would have busted or let it cash
out is gone with the process, and paying it out at the point it would have
reached rewards a restart. The house edge is the operator's to set within 0–20%
on Crash and is the wheel's zero on roulette; nothing adjusts an outcome for a
particular player, and `docs/decisions.md` says why that is written down.
Network latency on a cash-out cuts both ways and is the player's: the server
started the round before its reply reached the phone, and it reads the
multiplier when the cash-out arrives, so the server's number runs ahead of the
screen by the round trip. A cash-out that wins pays the server's reading, a
little more than the screen showed; a cash-out clicked just under the point can
arrive past it and bust.

## Identity hygiene: who can see a citizenid

A citizenid is the character's key in every micaOS table, and **on ESX it is the
player's Rockstar licence** (`users.identifier`). A device id names the phone
item a row was written from. Another player's phone number is a handle anybody
can dial. None of the three is a secret from the server, and none should travel
further than whatever receives it needs (MICA-433).

- **A player** sees their own phone number and nothing else of the three. No
  reply to them carries a citizenid or a device id, and a reply about another
  player never carries that player's citizenid or number: sending money to a
  number answers only whether it went through.
- **No app, core or add-on,** sees them. The `account` permission gives a phone
  number, a balance and transactions, and `useAccount` has no citizenid for
  anyone. The `getCitizenId` NUI callback is gone, and CEF never holds the
  player's citizenid, so an XSS in the page has none to read. The server knows
  who is asking and never needs the page to say.
- **The server console** names a character, or a number, by a `who()` token and
  never by the id. A payment that went through is not logged at all.
- **Discord** gets the same token in the Actor, From, To and Reporter fields,
  unless `mica_discord_webhook_content` is on, which puts the raw citizenid
  back. A society (`society:police`) is not a person and passes as it is.
- **Staff in Admin** are the deliberate exception. A report records the
  reporter's and the author's citizenid, and Admin reads them, which is what
  moderation is. That is why `admin` is core only.

The mechanisms, from the server outward:

- **`withoutOwnerKeys`** (`server/lib/replyShape.ts`) runs on every
  `ServiceEndpoint` reply, generic or custom, and removes every `citizenid` and
  `device_id` key at any depth. Owner reads used to answer whole rows (the
  generic `get` is a `SELECT *`), so a player's citizenid rode on every contact,
  photo and note, and on every add-on's own rows. It is applied at the reply,
  not per query, so an action written tomorrow is covered. A key that holds a
  citizenid under another name (`target_author`, `payee`) is that reply's own
  projection to leave out; the helper does not guess at it.
- **`checkReply`** (same file) holds a custom action's reply to the `output` its
  contract declares. Under test, or on a server with `mica_integration` set, a
  reply with an undeclared field throws, so the suite that drives the handler
  fails. On a live server the reply is sent as the schema reads it, so the
  undeclared field is stripped rather than leaked, and the mismatch is logged
  once per action, naming the fields and never their values. A reply the schema
  refuses outright is sent as it was and logged once, because a player should
  not lose a working action to a declaration that lagged. A `responseType<T>()`
  output has nothing to check against and passes untouched, so an action that
  answers about another player wants a real schema. `bank:sendMoney` is the case
  that wanted this: it answered the transfer's whole outcome, recipient
  citizenid included, so sending $1 to a number was a lookup of who holds it. It
  now answers `{ ok: true }` or the failure reason.
- **`withoutWithheldKeys`** (`web/src/shell/addon/IframeHostServer.ts`) is the
  fence on the shell side. Everything posted to an add-on's frame, whether a
  reply, a push, a callback's arguments or the hydrate payload, passes through
  it, and `citizenid` and `device_id` are removed at any depth. It is the layer
  that still holds when a server read forgets.
- **`admin` is refused for `core: false`** (`CORE_ONLY_PERMISSIONS` in
  `sdk/permissions.ts`). The moderation queue holds who reported whom and
  `target_author`, which unmasks a Dark Chat alias. Its facet rows are empty,
  `defineApp` refuses a manifest declaring it, and the shell shuts a frame whose
  manifest declares it before any facet answers, in case that manifest never met
  `defineApp`. `useAdmin` and `useReports` are typed empty on the add-on barrel.
- **`account` no longer includes the citizenid, and neither does anything
  else.** `citizenid` and `fetchCitizenId` left `useAccount` for core apps too;
  the client's `getCitizenId` callback and its route are removed, and
  `web/src/services/account.ts` keeps no citizenid store. `account` still gives
  the phone number, the balance and the transactions.
- **`search` is a permission.** A search provider is pushed every query the
  player types, a keystroke at a time, while the app runs, opened or not. That
  used to be implicit; it is now declared and shown on the Store's permission
  sheet.
- **`who()`** (`server/lib/who.ts`) is what a log line or a Discord field says
  instead of an id: HMAC-SHA-256 under a per-install salt, ten hex characters,
  stable across lines and restarts, and giving nothing back. The salt is drawn
  once and stored in `mica_schema_migrations` as `log-salt:<hex>`, so it costs
  no table and no `micaschema apply`. It is deliberately not the content key,
  which is optional and rotated: a token under it would change the day an owner
  enabled encryption, and every earlier line would stop matching. Until the salt
  is read a token carries a leading `~` and is good for one process only. A bare
  hash would not do: a citizenid is short and guessable.
- **`traceOf()`** (`server/lib/sqlErrors.ts`) is how an unexpected error is
  logged: the reason's one line and the stack's frames, never the message above
  them. An oxmysql error's message embeds the statement and every bound value,
  so `console.error('…', error)` printed whatever the query was about.
  `reasonOf()` is the one-line form.
- **`server/__tests__/logHygiene.test.ts`** reads every `console.*` call under
  `server/` and fails a raw error object, or a word naming an identity
  (`citizenid`, `phone`, `from`, `to` and the like), outside `who()`,
  `reasonOf()` or `traceOf()`. A line naming something that is not a player says
  so with a `// log-identity-ok: <reason>` comment above it. It fails closed: a
  file it cannot read to the end is a failure naming the file. It reads source,
  not a run, so a path no test reaches is still checked.

**What this does not cover.** The database holds every citizenid, the audit
ledger records them by design, and staff with Admin read the ones on a report. A
server owner's own scripts that log what they are given are theirs.

## Nothing is a real delete

Since MICA-428 micaOS deletes no player-content row. Every path that used to
`DELETE` one now moves its `status`, and the row stays, for staff and for
evidence. The status says who hid it, beside the player's own `deleted` and
staff's `moderated` (`server/lib/statuses.ts`):

- **`expired`**: a retention window passed. Retention (`mica_message_retention`,
  `mica_dm_retention`, `mica_media_retention`), Dark Chat's sweep and the
  notifications prune move `active` to `expired`, and only `active`: a row the
  player deleted stays `deleted`, a takedown's stays `moderated`. It is never
  restorable, so a player's Recently Deleted reads `deleted` only.
- **`erased`**: the owner is gone or asked to be. The privacy delete (MICA-168),
  the character-deleted purge, the start-up orphan sweep, the media-only purge
  and `micaseed clear` move everything the scope owns to `erased` in one
  `UPDATE` per table, with `updated_at` pinned because erasing is not an edit.
  It is on every service's status list, appended by `defineService`, and
  migration 0015 appended it to every status column. Hidden from everyone, the
  owner included, and withheld from the player's own data export.

What a purge leaves as it is:

- **A `moderated` row**, which is the evidence. Its takedown is told the owner
  erased it, so a reopen restores `erased`.
- **The audit ledger**, and **pending reports the player filed**, in every
  purge. A resolved report goes with the rest.
- **The phone number** (`mica_phone_numbers`) in the character-deleted purge and
  the sweep, so a deleted character's number is never issued to another phone.
  The phone itself, its lock-screen passcode and its battery (`mica_devices`,
  `mica_lockscreen`, `mica_battery`) are erased there with the rest (MICA-440):
  a phone is found by its character (MICA-438), and on ESX a new character in a
  deleted character's slot has the same citizenid, so a live phone row handed it
  the old phone, passcode included. The player's own delete keeps all four, and
  also keeps open invoices they owe and the import ledger.
- **A group thread or channel others are still in** (`registerSharedRows`). The
  owner's own membership and messages are erased, but the thread or channel
  stays live while another member is `active`, and the next orphan sweep erases
  it once the last has gone. Messages and Dark Chat register theirs.
- **A table with no `status`.** A purge skips it, since there is nothing to
  move. The rows below used to be this case and no longer are.

Nothing cascades, because an `UPDATE` reaches no other row, and the cascade-safe
plan that kept a parent while another player's row hung off it is gone. What a
cascade used to take is now named instead (below). A purge is also no longer
held back by an open report on the player's own rows: it erases them like any
other, and the row and the report's snapshot stay.

**The child rows are kept too** (MICA-429, migration 0016). Follows, blocks,
account reactions, Blabber ears, message reactions, Spark swipes, matches and
photos, and Hodlr's price history used to be deleted outright. Each now has a
`status`, and a change is a status change:

- an unfollow, an unblock, an un-react and an un-ear move the row to `deleted`,
  and a follow ended by a block to `blocked`, so following again is a new live
  row, not a collision with the old one. The unique keys sit on a live-only copy
  of the column (`NULL` once the row is not `active`), as Blabber's mouth key
  does;
- a Spark unmatch or a removed profile moves the match to `ended`, a new photo
  set moves the old one to `replaced`, and the sweep over old passes moves a
  swipe to `expired`, so the pair that was unmatched or passed on stays
  recorded;
- Hodlr's hourly prune moves a price older than seven days to `expired`. It has
  no owner, so nothing erases it.

**A purge reaches these through their parent** (`registerDependentRows` in
`server/lib/sweep/purge.ts`). They carry no citizenid, so a purge cannot find
them by owner. The service that owns the parent registers the columns that name
it: an erased account's follows, blocks, reactions and ears, an erased Spark
profile's swipes and matches. They move to `erased` in chunks with the parent,
and a run that stops part-way is finished by the next, because the parent is
still erased and its rows still match. Spark's photos carry the owner's
citizenid, so the purge finds those itself.

**A hosted file is never deleted.** Nothing deletes a `mica_media` row, so a
file on the image host is kept for as long as its row is, which is for good.
`mica_media_delete_url` is retired, and a server that still sets it is told once
at start that it does nothing.

**The cost is storage, and a larger answer to a subpoena.** A hidden row is
still in the database, and in every backup. What changed is who can read it, not
that it exists.

## A takedown is hidden evidence, and a reopen puts it back

When staff action a report, the reported row is not deleted: its `status`
becomes `moderated` (MICA-386, MICA-426). That is deliberate. The audit ledger
and the actioned report both point at the row, and a reopen, which is staff
judging the content safe after all, has to have something to put back.

**Hidden everywhere a player sees it.** A taken-down message leaves the thread,
the inbox preview and the unread count in Messages as it does every other app's
list. A reopen puts it back by id in its old place, unchanged and not marked
"edited": `moveStatus` in `server/lib/moderation.ts` pins `updated_at` on both
halves of the round trip, because every table's `ON UPDATE CURRENT_TIMESTAMP`
would otherwise read as an edit, and would reset Media's Recently Deleted clock.

**Held from everything that hides.** A `moderated` row is kept by every
retention prune (Messages, direct messages, Media), by the Dark Chat sweep, and
by every purge: character delete, the start-up orphan sweep, the media-only
purge, and a player's own privacy delete. The retention side is `evidenceHold`
in `server/lib/contentRetention.ts`, read off the row's own `status` rather than
off `mica_reports`, because once a report is actioned the open-report hold no
longer names the row. The purges leave a `moderated` row as it is
(`status NOT IN ('moderated', 'erased')` in the `UPDATE`). The hold ends when
the row stops being `moderated`, and the next sweep expires it by its window as
usual. That is why Dark Chat's 24-hour window still applies to a restored line:
a line that would have expired anyway comes back and expires at the next sweep.

**The owner's deletion wins.** A reopen restores the status the takedown
recorded, and that was read while the content was live. If the owner has since
deleted or erased it, handing it back would undo their decision, so the paths
that hide a row whatever its status tell the takedown first: a Spark profile
removal and a Spark unmatch's thread delete record `deleted`, and the purges
record `erased` (`recordOwnerDeletion`). The row itself stays `moderated`, and a
reopen restores what was recorded. A purge does this after its `UPDATE`, so a
takedown that lands before the write is found, and fails if it cannot.

**A reopen that cannot restore says so.** If the content cannot be brought back
as it was, the admin gets `server.reports.notRestorable` and the report stays
actioned. Such a report cannot be reopened.

## Accepted risks

Accepted against the feature set at `0922a9b` (2026-08-29) — a risk below was
weighed against what existed then, and a service added afterward is not covered
by this list until someone re-weighs it.

- **Holding the phone item is the gate, and the item carries nothing
  (MICA-438).** micaOS neither reads nor writes an inventory item's metadata. A
  character's phone is their own `mica_devices` row, found by the `citizenid`
  the server resolved from the framework connection, so there is no claim on an
  item to weigh and nothing in an inventory that a resource could write to reach
  somebody else's phone. What remains is the count itself: `holdsDevice` asks
  the inventory how many of the item a player holds. A resource that can add
  items can make a player _hold_ a phone, and the phone it opens is their own,
  so there is nothing to gain; a duplicated item is another key to the same
  phone. A resource that can remove items closes the phone for its holder until
  they hold another. That is a denial and no more: the data is untouched and the
  same phone is there for any item. The item is therefore a control on whether a
  player can open their own phone, and on nothing else.

  **How the identity got here, because each earlier step was an accepted risk of
  its own.** MICA-281 minted a phone id into the item's metadata and weighed it
  as a claim: `Repository` will not accept a phone id as an ownership predicate
  on its own, since the citizenid the server resolved stays required and the
  phone id only ever narrows a `WHERE` that already has an owner in it. MICA-282
  then made holding the item the thing that moved rows, so that a duplicated or
  stolen item stood between a thief and a full read of its owner's phone with
  nothing but a passcode only the client checks. MICA-436 removed the handover
  and made a used phone a brick for anyone else. MICA-438 removed the item from
  the identity altogether, which is what closed the question. Two of MICA-281's
  protections do not depend on any of that and stay: `device_id` is in both
  `NEVER_CLIENT_WRITABLE` and `NEVER_CLIENT_FILTERABLE`, so a payload can
  neither set one nor filter by one — the latter matters because "I once held
  this phone" would otherwise become a query for everything that phone owns —
  and a phone id is not a secret, so nothing should ever be authorized by one
  alone. What stays with the person regardless — money, listings, social
  accounts, authored messages — is listed in `docs/schema-and-services.md`, and
  a table is moved onto the phone only by declaring `deviceOwned` on it.

  **MICA-264 adds a second kind of device, and the kind is the server's
  choice.** A tablet item and a phone item each open the holder's own row of
  their own kind (`identityDevice` takes the kind as an argument), so no copy of
  one item can make one device the other. A tablet never gets a phone number.
  The device a request names — the third argument of every `ServiceEndpoint`
  event — is attacker-controlled as well, and only ever chooses between the
  caller's own two devices: a value that is not a device is refused, a service
  answers only the devices it declares (`devices` in `defineService`), and a
  request for the tablet is refused unless the tablet is switched on and the
  caller holds one. A request naming no device is the phone, as every client
  before MICA-264 sent.

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
- **An invoice is the one row a client can move money against, and a client can
  only point at one of its own.** `Invoices.ts` registers no generic action; a
  row exists only through the `SendInvoice` export, where the server decides the
  amount and the counterparty. `pay` and `decline` resolve the id through the
  owner-scoped `findById`, so somebody else's id answers `unknown_invoice`
  exactly as a bad id does, and `pay` claims the row out of `active` in one
  statement before `Payments` runs — the statement's own predicate is the
  double-pay defence, not a check-then-write in TypeScript. A modified client
  can pay or decline its own invoices faster than a finger can, and nothing
  else.
- **The Jobs service takes a job name from the client and acts on it — but only
  after matching it against the framework's own list for that player.**
  `Jobs.ts`'s `setActiveJob` and `setDuty` compare the payload's `name` against
  `FrameworkPlayer.getJobs()` first and answer `unknown_job` on a miss, so a
  name never reaches `SetPlayerPrimaryJob`, a duty setter or the banking
  bridge's society read unless the core already says the player holds that job.
  What a modified client can do is switch between jobs it genuinely holds and
  clock on or off, which is what the in-game commands already let it do; the
  society balance is answered only for a boss grade of the job named, and no
  action moves society money.
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
  its imports. `account` gives no citizenid, `admin` can never be declared by an
  add-on, and a search provider declares `search`
  ([Identity hygiene](#identity-hygiene-who-can-see-a-citizenid), MICA-433). Nor
  can `bank` (MICA-441): `sendMoney` pays any number and `payInvoice` settles a
  bill, and one tap on a Store add-on's permission sheet was never the player
  agreeing to each payment that code, which nobody on the server reviewed, then
  makes. Only a core app moves money through the bank. An add-on with its own
  server service, as Casino and Hodlr have, still spends the player's own money
  inside that service's caps, and never to another player. **Consent is the
  shell's own record, not the manifest** (MICA-201). It used to be neither:
  MICA-196 compared an update's permissions against the _installed manifest_, so
  the manifest was its own authorization and anything able to write one — a
  modified Store, or any core path that installs a catalog entry — widened what
  an add-on could reach with nobody asked. The set the player accepted now lives
  in `web/src/shell/state/addOnGrants.ts`, keyed by add-on id and persisted per
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
- **The `call` facet's `toggleSpeaker` reaches other players** (MICA-246): an
  app holding it can put a connected call on speaker, which moves up to six
  nearby players into that call's voice channel. Same class as `answerCall` —
  the server decides who, from its own positions, and only for a party to an
  answered call.
- **Where the bytes are fetched from is checked, and checked again on update.**
  `isTrustedRemoteUrl` (`sdk/remoteAppSecurity.ts`) requires HTTPS plus a
  hostname on an operator-configured allowlist. It exempts `data:` URLs, because
  `installFromCatalog` only ever builds one internally from bytes it has already
  hash-verified; that exemption is not safe to hand untrusted input directly, so
  the caller is responsible for rejecting a `data:` URL first —
  `nuiMessages.ts`'s `installApp` handler does exactly that, refusing a `data:`
  `bundleUrl` at the NUI boundary before `isTrustedRemoteUrl` ever sees it. An
  update is not exempt from any of this either: `appUpdates.ts` re-fetches the
  bundle and re-verifies it against the catalog entry's **fresh** `sha256`, the
  same check a first install runs, rather than trusting a previously-verified
  hash to still apply.
- **A stock server offers the project's public catalog, and its host is the
  residual risk (MICA-237).** With `mica_addon_catalog` never set, the Store
  lists `https://mica.gg/addons/sdk-<n>/catalog.json` and `mica.gg` is on the
  allowlist; `off` removes both. Accepted because nothing a catalog says can
  reach a player unasked: every bundle is pinned to the SHA-256 in its entry and
  re-hashed on every fetch, runs in the sandbox above under the permissions the
  player agreed to, and an update that asks for more permissions prompts again.
  What is trusted is the host itself — whoever controls `mica.gg` chooses what a
  new entry, or a new version of one, contains, and a player who installs it
  gets that code inside the sandbox. The catalog lists only add-ons the resource
  does not ship, so it cannot replace a built-in app. **The server fetches the
  catalog, not the phone**, so the host learns the server's address and never a
  player's; a player's phone contacts a bundle's host to download an add-on the
  player chose to install, and again at each phone boot for add-ons already
  installed, since rehydration re-fetches and re-verifies every one.
- **A dev add-on skips the hash and the consent sheet, and exists only where a
  build flag allows it (MICA-311).** `?addonDev=<base>` loads an author's add-on
  from their own machine so they can see it without a server. The loader
  (`web/src/shell/addon/devAddOn.ts`) is imported only behind
  `import.meta.env.DEV || VITE_MICA_ADDON_DEV === '1'`, both replaced at build
  time: `pnpm dev`, the e2e build and the public demo container have it, and the
  game build does not contain it. `scripts/check-no-dev-addon.js` fails the game
  build, and refuses to pack the resource, if its marker string appears anywhere
  in `dist/web`, and `demo:smoke` asserts the opposite of the demo image. At run
  time it also refuses outside a plain browser tab. The base must be
  `localhost`, `127.0.0.1` or `[::1]` after WHATWG parsing, with no credentials,
  query or hash. Both fetches refuse redirects and send no credentials, and the
  bundle must share the base's origin. **Waived: the SHA-256 compare and the
  consent sheet**, since the bytes are the author's own. The grant is the
  entry's declared permissions, held in memory and never saved. **Not waived:**
  the add-on registers through the same `registerAddOn` checks and runs in the
  same sandboxed `srcdoc` frame, under the same CSP and `networkHosts`, with
  every call re-checked against its grant and its own service namespace. A strip
  the shell draws, which the add-on cannot draw over, names the source. A link
  to the demo with `?addonDev=` pointing at a visitor's own machine can only
  send two GETs to fixed paths there, which any web page can already send.
  Reading the answer needs that machine to allow `mica.gg` by CORS, and what
  runs is that machine's own code, inside the sandbox. The author's service is
  mocked **inside the add-on's frame** (`@mica/sdk/dev`), never in the shell,
  and a production add-on build refuses to import it.
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
  hatch: `connect-src` is `networkHosts` or `'none'`; since MICA-202 `img-src`,
  `media-src` and `font-src` are `data: blob:` plus `networkHosts`, and
  `img-src` alone also carries the server's image host when one is configured
  (MICA-243); `frame-src`, `child-src`, `form-action` and `base-uri` are
  `'none'`, and `child-src 'none'` also stops Web Workers. Since MICA-442
  `script-src` and `style-src` are `'unsafe-inline'` (and `'unsafe-eval'` for
  scripts) plus `data: blob:` plus `networkHosts`. Until then both also allowed
  any `https:` or `http:` host, the reach they had before MICA-196, which let a
  pinned bundle `import()` code its SHA never covered and carry a payload out in
  a script or stylesheet URL, plaintext included. The add-on's bundle is inlined
  into the frame as one module script with its CSS injected as a `<style>`, so
  it needs neither. **What stays open, said plainly:** a host an add-on declares
  can serve it a script, so what runs in the frame is the pinned bundle plus
  whatever its declared hosts serve. The manifest shows those hosts; nothing
  here can show what they serve tomorrow.
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
  whole of MICA-70: no encryption at rest, a retention window, or a player's own
  export and delete. All three have since landed: encryption at rest (MICA-165,
  [Message bodies at rest](#message-bodies-at-rest)), which protects a stolen
  dump but still not against the operator, who holds the key; retention windows
  (MICA-167); and a player-facing export and delete (MICA-168, below).
- **A player's own delete keeps moderation records and never takes another
  player's rows, and their export withholds what is not theirs (MICA-168).**
  Settings > Privacy > Your data exports every owned table for the session's
  character — never a payload's — and deletes it behind a typed `DELETE`,
  through `purgeOwnedRows` (MICA-428: it moves rows to `erased`, it deletes
  nothing; see [Nothing is a real delete](#nothing-is-a-real-delete)). A row
  staff have taken down (`status = 'moderated'`) is kept as the evidence it is,
  and each takedown holding one has its record moved to `erased`, so a reopen
  restores it as erased rather than handing the content back. It never touches
  another player's rows, because an `UPDATE` by owner reaches only the player's
  own, and it keeps the accountability records: the audit ledger (a staff member
  could otherwise erase their own moderation record), reports still pending
  review (hiding one would release the hold on what it names), unpaid invoices
  someone else issued, and the import ledger (without it a re-run of
  `micaimport` restores what was erased); and, live, the device's own phone,
  number, battery and lock, which an erase while the player is online would
  desync. The reply counts what was kept. Deleting the character erases the rest
  of those too, but keeps the character's pending reports, audit rows and device
  rows. The export withholds credential columns (the lock-screen passcode hash
  and salt), columns naming another player (a report's target and preview, an
  invoice's payee, a conversation's other party), rows an erase hid, and the
  audit ledger, whose rows carry what admins read of other players, plus the
  blind-index and `seal_key` columns, which are lookup and sealing machinery and
  not the player's data; media bytes become their size, the plaintext size even
  when the photo is sealed (`plaintextBytesSql`), not the length of the stored
  ciphertext. Each owned table's exported columns are pinned by a test, so
  exposing a new column is a decision, not a default. Both actions are
  audit-logged with counts and no content, and an export is never posted to the
  staff Discord. The rate limits (a few exports a minute, one completed delete
  an hour) are in memory, so a resource restart resets them.
- **A hosted photo is kept, not deleted (MICA-292, MICA-428).** With an image
  host configured (MICA-243), a photo is a public URL, so a file kept after its
  owner has gone is a privacy leak and not just a storage bill. micaOS used to
  ask the host to delete each file no remaining row named; it no longer deletes
  anything, so a hosted file outlives its character, its retention window and
  its erase, along with the row that names it. That is the trade for keeping
  every row, and an owner who wants files gone does it on the host. **A refused
  upload insert keeps its file too**: the upload happens before the insert, so a
  player at their quota leaves a file no row names, and
  `refuseUploadWithoutRoom` turns most of those away first. **The
  `ON DELETE CASCADE` from `players` on qb is gone** (migration 0006, MICA-300):
  it removed a character's rows inside MariaDB when the framework deleted the
  character, with no hold, and so without the erase that now keeps them. The
  property is checked against `information_schema`, never the migration ledger
  (`server/lib/ownerForeignKeys.ts`): re-importing `mica.sql` records 0006 as
  applied while every `CREATE TABLE IF NOT EXISTS` keeps the old keys, so
  `micaschema apply` drops any it finds as its first step whatever the ledger
  says, and every resource start logs an error naming the tables while any
  remain, or a warning when it cannot tell.

- **A security scan of `server/` and `shared/` on 2026-10-08 (MICA-339) left six
  things open on purpose.**
  - **Imported message bodies can still be confirmed from import ledger entries
    written before MICA-340, until they are re-keyed.** With a content key
    configured, a qb-phone message's `mica_import_ledger.source_key` is now
    `hmac:<kid>:<hex>`, an HMAC under that key. An entry written before MICA-340
    holds the raw key (both participants, the date, the minute, the sender and
    the body) or, past 64 characters, which is most messages, its unkeyed SHA-1,
    which anyone with a dump can test a guessed message against.
    `micacrypt backfill --apply` keys the raw entries; a SHA-1 cannot be undone,
    so only a `micaimport qb-phone --apply` re-run keys those, for every source
    row it can still read. `micacrypt status` counts what is left. Without a
    content key, new entries stay in the old form, since the bodies are
    plaintext then anyway. An HMAC entry matches a re-import only while its key
    is in the key file, so `micaimport --apply` refuses to run while any entry
    is keyed under a key the file no longer holds, rather than import those
    messages twice. The exposure begins only once the qb-phone tables are
    dropped, since until then the same bodies sit there in plaintext, and by
    then a re-run can no longer key what is left.
  - **A client can still overhear a call for about one server tick** (MICA-341).
    A call's id is its pma-voice channel, and pma-voice's own `setPlayerCall`
    net event lets any client join any channel. The server now places both
    parties itself and takes back out anyone found in a live call they were not
    placed in, but pma-voice has already routed the audio by then, so a client
    that loops the event can catch fragments. Call ids are 31 bits from
    `node:crypto`, so finding a live one is a guess as well.
  - **Holding a phone is enforced on the server for a named set of writes.** On
    a server with `mica_phone_item`, sending money, paying an invoice, trading
    on Hodlr, posting a listing or a Blab, sending a message or a DM, and
    starting a music broadcast refuse a player holding no phone
    (`requirePhoneFor` on the endpoint). Reads are left open so a phone-less
    player's shell still boots and loads its badges. Other writes still run for
    a phone-less player: following and reacting on Blabber, a Blabber ear,
    sharing a contact or a live location, marking a listing sold or removing it,
    and declining an invoice. `SetPhoneEnabled(false)` is still enforced by the
    player's own client only.
  - **A stolen phone keeps receiving its owner's new rows, and nobody but the
    owner can read them.** Notifications, line texts and dropped photos for a
    character are filed on their one phone (`phoneForCitizen` in
    `server/services/Devices.ts`), and a text or call to its number is filed on
    the phone that owns the number. Nothing tells a stolen phone from one in a
    stash, and the owner chose that a stashed or confiscated phone keeps
    receiving, like a real one (MICA-339). The thief holding the item opens
    their own phone, a different row, so none of it reaches them; it waits on
    the owner's phone until the owner holds a phone item again, any one, and a
    new item opens it as the old one did (MICA-438).
  - **A number that moved to another phone can show on a call for a while after
    a restart.** On qb, `charinfo.phone` is no longer used once another citizen
    holds that number, but until the new holder's number syncs after a resource
    restart nothing says so. Since MICA-436 nothing moves a number to another
    citizen, so this is reachable only through a `mica_phone_numbers` row
    written before it that still names a previous holder, on a development
    database. Since MICA-438 the first sync of the phone it sits on detaches it
    (`detachForeign` in `server/services/PhoneNumbers.ts`): it is the named
    citizen's legacy number again, their own phone takes it on their next sync,
    and the phone's owner goes on to their own number. The console says so once
    per row, by token. Until then qb's `charinfo.phone` can lag.
  - **Media rows and Blabber avatars written before this fix may hold a remote
    URL.** Avatars written since, by a player or by `micaimport`, must be an
    inline image. The old media rows are kept, but nothing draws them: a
    thumbnail draws only an inline image from `data`, and a wallpaper takes only
    an inline image or an `https` source with no quote, parenthesis or
    whitespace, escaped. An old remote avatar does still draw in the Blabber
    feed, so it still reaches the address it names, until its owner changes it.

---

## What the test suite cannot tell you

Every test here drives the **server** directly. That proves the server refuses —
not that the client is the only thing asking. Confirming the NUI surface needs
`nui_devTools` in game and a look at what `RegisterNuiCallbackType` actually
registered.

Nothing in the automated suite exercises a modified client, a real CEF instance,
or another resource calling an export. Those are the three places this
document's assumptions actually get tested.
