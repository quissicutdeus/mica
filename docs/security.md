# Security model

What gPhone trusts, who it trusts it from, and why. `AGENTS.md` §2.9 and §7 carry the rules this
document explains; where they disagree, `AGENTS.md` wins and this file is wrong.

Written after a pass over the resource's entry points. It is not a checklist — a checklist tells you
what was done, and what matters here is what is _assumed_, because an assumption nobody wrote down is
the one that gets broken by a well-meaning change.

---

## The one rule

**The phone is an untrusted client.** Every payload it sends is attacker-controlled, and the server
authorises everything on its own account.

Two separate reasons, and they have different blast radii:

- **CEF XSS.** Injected script in the page can `fetch` `https://<resource>/<callback>` and invoke any
  **registered NUI callback** (§7). That is why player-supplied strings never reach `{@html}`
  unsanitised, and why an anchor is never in the DOMPurify allowlist.
- **A modified game client.** It can `TriggerServerEvent` **any server event directly**, with no NUI
  involved at all.

The second is wider than the first, and it is the one that is easy to forget.

### The route table was never a security boundary

`shared/routes.ts` maps NUI action names to server events, and `routes.test.ts` cross-references it
against the `fetchNui` calls, the server registrations and the browser mock. Its job is catching a
**missing layer** — the failure that silently does nothing in game.

It bounds what CEF XSS can reach, because XSS is confined to registered callbacks. It does **not**
bound a modified client, which never touches NUI. So:

> **A registered net event is reachable. "The UI does not call it" is not a control.**

This was easy to miss while every reachable action happened to have a route in front of it. The
generic service route decoupled the two and made it visible — `accounts:delete`,
`notifications:get`, `notifications:delete` and `blabber_dms:delete` were all registered, routed by
nothing, and called by nothing. They are no longer registered.
`server/__tests__/reachability.test.ts` keeps that deliberate.

**Correction to the record.** The commit that added the generic route claimed it did not widen what
NUI can reach. That was wrong: the route table is a strict subset of registered actions, so unrouted
ones became reachable from the page as well as from a modified client. No privilege escalation and no
cross-player access resulted — every one was owner-scoped — but the claim should not be trusted as
written.

---

## Entry points

### 1. NUI callbacks

Named routes in `shared/routes.ts`, plus the generic `svc` callback, plus the client-only actions
that never reach the server. All of them land in `ServiceEndpoint.registerEvent`, which applies, in
order:

1. **Rate limit** — `allow(source, service, action)`, fixed 60-second window,
   `gphone_rate_limit` per window. Before the player lookup, so a flood does not make the server walk
   the framework's player table. Cleared on `playerDropped`, because FiveM reuses server ids.
2. **Authentication** — no loaded character, no answer.
3. **Payload reduction** — every key checked against the schema's `clientWritable` set. `id`,
   `citizenid`, `created_at`, `updated_at` and `status` are never client-writable.
4. **Per-column validation** — length and enum rules derived from the schema, because non-strict
   MySQL truncates silently: row written, success reported, data quietly wrong.
5. **Ownership** — `update` and `delete` carry a `citizenid` predicate. A row id is never
   authorisation. Shared rows check membership instead.

### 2. Raw `onNet` handlers

**Six**, in `Phone.ts` and `Battery.ts`. They sit outside `ServiceEndpoint` because they answer
fire-and-forget events with no callback id, so they cannot go through it, and they had no rate limit,
no authentication and no payload validation.

There were eight. `battery:save` and `signal:rules` are gone rather than guarded — both existed so
the client could tell the server something the server now decides for itself, and deleting an entry
point beats hardening one. `Signal.ts` has none left at all.

`guardNetEvent` in `server/lib/netGuard.ts` is the preamble for the remaining six, applying the same two
checks in the same order the endpoint uses: rate limit first, then the authenticated player lookup —
`getPlayer` walks the framework's player table and a flood should not make the server pay for that.
Refused **silently**, because there is nobody waiting on a reply to be told; `ServiceEndpoint` answers
its refusals only because `fetchNui` would otherwise hang for fifteen seconds.

Payloads are narrowed by `phoneNumberFrom` and `levelFrom` in the same module. The second is worth
naming: `Number(null)` is `0` and `Number('')` is `0`, so a client sending nothing at all used to
produce a valid "0% battery" rather than a refusal.

`gphone:server:admin:setBattery` is gated on `isAdmin(source)`, as are the moderation actions in
`Reports.ts`. Privilege is checked against the ace list, never against which route was used.

### 3. Exports

**A different trust boundary.** Exports are called by other _resources_, not by players. A hostile
resource is out of scope: it already has server-side execution and could do anything regardless.

What the contract protects against is a **buggy** one. Hence: arguments validated, discriminated
outcomes rather than bare booleans, never throwing across the boundary, identity passed explicitly
rather than read from an implicit `source` global — `onNet` also registers a local handler, so
`TriggerEvent` from another resource would otherwise supply the wrong player.

`SendNotification` validates its `app` against known services and namespaces external callers under
`ext_`; `AddMedia` refuses a `url` or `thumbnail` whose scheme is not `http(s)` or `data:image`.

---

## Client-authoritative values

**One is legitimate. Two have since been fixed** — and this section used to call all three "by
design", which is exactly what let two "has not moved yet" cases read as "cannot move".
That framing was wrong and worth correcting: the default is server-authoritative, and anything the
client owns needs a reason it _cannot_ move rather than a reason it has not.

### `PhoneState.isTyping` — legitimately client-owned

The server cannot see DOM focus. There is no server-side version of "this player has a text field
focused", so the web pushes it over on `focusin`/`focusout`. It suppresses keybinds; asserting it
wrongly costs you your own hotkeys and nothing else.

### Battery charge — moved

The client ran the drain timer and reported over `gphone:server:battery:save` every fifteen
seconds, so a modified client asserted whatever charge it liked. Validating that payload never
changed what it was, so the event is **gone** and the server ticks the number itself.

The authoritative version is smaller than the one it replaced: one interval and a map, against a
client timer plus a report path plus a clamp plus a write-skip cache that existed to absorb four
redundant writes a minute. Keyed by source, so it only ticks while connected — which the server
knows and the client merely stopped doing. A push and a write happen when the **whole percent**
moves, roughly once a minute rather than every tick.

### Signal bars — moved

Zone evaluation happened on the client: the server pushed the zone list and each client decided its
own bars. That was defensible only while nothing read the level, and it stopped being defensible the
moment an app was going to degrade at zero bars — a client that decides its own bars is a client that
decides whether it is in a dead zone.

The server polls now and the client is told a number. It no longer receives the zone list at all,
which is the load-bearing half: **a client that cannot see the zones cannot decide it is outside
one.**

The cost that originally pushed this to the client is real and is bounded twice. An early-out means
the ordinary case — no zones, full global signal — reads no coordinates at all, and a push happens
only when a player's whole-bar value changes rather than every poll.

`gphone:server:signal:rules` went with it, so the service has no raw `onNet` handler left — one fewer
entry point rather than one better guarded.

Done **before** any app reads the level, which was the point: the alternative was shipping the first
version of dead-zone degradation exploitable and fixing it afterwards.

## Accepted risks

- **Owner-scoped actions reachable beyond what the UI offers.** A modified client can invoke any
  registered action against its own rows. Closing that entirely would mean an allowlist per action
  on top of the access axes that already express it. The mitigation is to register only what the app
  uses, which is now tested.
- **`permissions` on a manifest is a disclosure, not a sandbox** (§7). Every app runs in the shell's
  own JS context, so any check the browser makes is one an add-on can walk around.
  `sdk/permissions.ts` maps every host hook to a permission; `permissions.test.ts` fails the build
  where a manifest understates its imports.
- **An add-on's code is trusted once installed.** The Store installs a bundle that runs in the same
  context as the shell. §2.9 is what stands behind it: the server does not care which app is asking.

---

## What the test suite cannot tell you

Every test here drives the **server** directly. That proves the server refuses — not that the client
is the only thing asking. Confirming the NUI surface needs `nui_devTools` in game and a look at what
`RegisterNuiCallbackType` actually registered.

Nothing in the automated suite exercises a modified client, a real CEF instance, or another resource
calling an export. Those are the three places this document's assumptions actually get tested.
