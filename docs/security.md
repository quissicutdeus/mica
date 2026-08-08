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

Eight handlers in `Phone.ts`, `Battery.ts` and `Signal.ts` sit **outside** `ServiceEndpoint`. They
had no rate limit and no payload validation until this pass; they now carry the same `allow()` the
endpoint uses, so the budget is shared. Refused silently, because a fire-and-forget event has no
callback id to answer on.

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

## Deliberately client-authoritative

Three values the client owns. Each gates **presentation**, never authority — and each is written
down here so the next person does not "fix" one by moving it server-side and breaking what it was
for.

| Value                 | Owned by | Why that is safe                                                                                                                                                                                                                            |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Battery charge        | client   | The drain loop lives there and reports every 15s. A faked charge means a phone that stays on. Clamped and rate limited server-side.                                                                                                         |
| Signal bars           | client   | The server owns the _rules_ — global level, zones, overrides — and the client evaluates its own position, because the server does not know where anybody is standing without asking every tick. A faked signal draws four bars in a tunnel. |
| `PhoneState.isTyping` | client   | The client cannot see DOM focus, so the web pushes it over. It suppresses keybinds; asserting it wrongly costs you your own hotkeys.                                                                                                        |

The test: **could a player gain something another player has to earn?** For all three the answer is
no, which is what makes client authority acceptable here and not elsewhere.

---

## Accepted risks

- **Owner-scoped actions reachable beyond what the UI offers.** A modified client can invoke any
  registered action against its own rows. Closing that entirely would mean an allowlist per action
  on top of the access axes that already express it. The mitigation is to register only what the app
  uses, which is now tested.
- **`permissions` on a manifest is a disclosure, not a sandbox** (§7). Every app runs in the shell's
  own JS context, so any check the browser makes is one an add-on can walk around.
  `sdk/permissions.test.ts` fails the build where a manifest understates what its imports touch —
  that keeps the disclosure honest; it does not make it enforcement.
- **An add-on's code is trusted once installed.** The Store installs a bundle that runs in the same
  context as the shell. §2.9 is what stands behind it: the server does not care which app is asking.

---

## What the test suite cannot tell you

Every test here drives the **server** directly. That proves the server refuses — not that the client
is the only thing asking. Confirming the NUI surface needs `nui_devTools` in game and a look at what
`RegisterNuiCallbackType` actually registered.

Nothing in the automated suite exercises a modified client, a real CEF instance, or another resource
calling an export. Those are the three places this document's assumptions actually get tested.
