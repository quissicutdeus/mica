---
name: nui-endpoint
description:
  Wire a call from the phone UI to the FiveM server, or a push from the server
  to an app. Use whenever adding or changing a fetchNui call, a route, a
  registerEvent handler, a custom service action, or a server-to-app
  notification. A layer left out fails silently in game while passing every
  suite.
---

# Wiring a NUI round trip

The most common bug this repo has shipped: a feature that works in `pnpm dev`
and in Playwright, and does nothing in game. `readConversation`,
`renameConversation`, `archiveConversation`, `rejectCall`, `flipCamera` and all
four mail actions have each shipped as a silent no-op.

**Why the suites don't catch it:** `web/src/nui/mocks/registry.ts` answers by
action name alone. A mock makes a missing client or server layer invisible.

## UI → server: four places, not three

| #   | File                            | What                                                                     |
| --- | ------------------------------- | ------------------------------------------------------------------------ |
| 1   | `shared/contracts/<service>.ts` | the action's `input` (and `output`) in the service's `defineContract`    |
| 2   | `web/src/services/`             | `call(<service>Contract, 'action', input)` from `web/src/nui/call.ts`    |
| 3   | `server/services/<Service>.ts`  | `registerEvent('<action>', ...)` — the handler receives the parsed input |
| 4   | `web/src/nui/mocks/registry.ts` | the browser/Playwright mock, under the scoped key `'<service>:<action>'` |

The typed call rides the generic service action (`svc`), the same door an
add-on's `useService(id).call(...)` goes through, so a contracted action needs
**no row in `shared/routes.ts`** and no client relay code. A `route()` entry is
only for a generic CRUD action a `createCrudStore` reaches by its NUI name, and
its mock is keyed by that name. An action that needs a client-side step before
it leaves the client (a native only the game can run) is marked `clientPrepared`
in the contract and registers that step with `registerClientHook` in
`client/lib/clientHooks.ts`; the relay refuses to forward one that has no hook.

Miss the contract and the resource refuses to start; miss the mock and the e2e
spec that reaches it fails; miss the handler and the call times out in game.

`server/__tests__/routes.test.ts` cross-references all four. If it is red, a
layer is missing; do not silence it.

**Touching an existing endpoint:** grep `client/` and `server/` for the action
name before assuming it is wired.

## Rules

- **Never hand-write a response event name.** `shared/rpc.ts` owns
  `requestEventFor` / `responseEventFor`; `ServiceEndpoint` and `ServiceProxy`
  both import them, and `ServiceProxy.registerCallback` subscribes the derived
  reply itself. A hand-written reply name times out after 15s, silently.
- **Event names are `gos:<side>:<app>:<action>`, no exceptions.**
  `server/__tests__/eventNames.test.ts` scans source and rejects anything else,
  including an `<app>` segment that is not a declared app. Two non-app scopes:
  `shell` (the phone itself) and `admin` (the privileged surface). NUI _message_
  actions (`setVisible`, `receiveMail`) are a separate namespace and carry no
  `gos:` prefix.
- **A registered net event is reachable** whether or not a route points at it —
  a modified client emits it directly. Do not register a generic action the app
  does not use; `server/__tests__/reachability.test.ts` keeps that honest.
- **Trust nothing in the payload.** Every field and row id is
  attacker-controlled. See AGENTS.md §2.9 and `docs/security.md` before adding a
  write: identifier allowlist, ownership predicate, `clientWritable`.
- Payload shape: generic CRUD reads the row id from `data.id`.
  Conversation-scoped custom actions accept `conversation_id`, `id`, or a bare
  id via `conversationIdFrom` in `server/lib/payload.ts`.

## Server → app push: also four files

| File                           | Does                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| `shared/appEvents.ts`          | the net event name, the NUI action, `parseAppEventEnvelope` |
| `server/lib/appEvents.ts`      | `appEventChannel(appId).push(...)` → `PushOutcome`          |
| `client/services/AppEvents.ts` | forwards the envelope into NUI (not `ServiceProxy`)         |
| `web/src/shell/nuiMessages.ts` | the one generic `appEvent` route, dispatched by app id      |

The app subscribes with `useAppEvents(appId)`.
`server/__tests__/appEventContract.test.ts` catches a missing layer.

- **One literal net event**, `gos:client:shell:appEvent`. A templated per-app
  name would be an unchecked name.
- **Subscribe in the store, not the component, if you must not miss anything.**
  The CEF page never unloads; a store subscription is permanent, a component one
  lives as long as the component and is replayed from a bounded buffer on mount.
- At-most-once, ordered within a session, best-effort across. Nothing is queued
  server-side — the row is already written, so an offline player gets it from
  the ordinary fetch. `onAppForeground` is still required.
- A push must never fail the write that occasioned it: dispatch after the write,
  log the rejection rather than throwing.
- `pushMany` takes one `getAllPlayers()` snapshot; deduplicate by **owner**
  first where identity is an account, and drop self-mentions.
- **`notifications` gates the toast, not the data.** Withholding the payload
  would be theatre — the app can fetch the same rows through its own service —
  but the disclosure stays true at runtime.

## Done

`pnpm check:fast` while iterating; `pnpm verify` before reporting complete
(AGENTS.md §9). A green suite is **not** evidence the feature works in game —
say so.
