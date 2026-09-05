# Registered numbers: a resource owns a phone line — MICA-226

A script registers a phone number, answers calls placed to it, and can start a
call on a player's behalf. This is the feature every "call the mechanic" or
"phone the dispatcher" integration is blocked on, and the one
`server/lib/publicApi.ts` deferred when it shipped `GetEmergencyNumber`.

Delete this file when MICA-226 ships, the way `10932ea4` removed the Blabber
design and plan docs once they landed.

## Scope

**In:** `RegisterNumber`, `UnregisterNumber`, `CreateCall`, the `onCall`
handler, per-resource ownership with resource-stop cleanup, and re-expressing
the emergency number as a registered line.

**Out, deliberately:** `onMessage`. Texts are not phone-to-phone in this schema
— `Conversations.ts` keys threads on citizenids, and
`mica_messages_participants.citizenid` carries
`FOREIGN KEY REFERENCES players(citizenid) ON DELETE CASCADE`. A script-owned
line has no `players` row, so it cannot hold a participant row, and membership
is exactly what the participants table decides. Giving a line a synthetic
identity means either dropping that constraint or writing rows into the
framework's own `players` table, and that is a data-model decision about whether
non-player identities exist here at all. It gets its own story.

## Decisions

| Question                                          | Decision                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| What does a script "answering" mean for voice?    | Signalling only. `accept`, `reject`, `forward(source)`. A script has no microphone; voice joins only when a forward lands on a real player. |
| Registered number collides with a player's number | The player always wins, re-checked on every call.                                                                                           |
| Can a player block a script line?                 | Per-registration `blockable`, defaulting to `true`.                                                                                         |
| How is the handler invoked across resources?      | Function refs passed through the export, returning a verdict.                                                                               |
| Line identity for texts                           | Deferred with `onMessage`.                                                                                                                  |

## Components

**`server/lib/numberRegistry.ts`** (new) owns everything about registered lines:
the number → `{ owner, onCall, blockable }` map, ownership and cleanup, and the
guarded handler invocation. Nothing outside it knows how a handler is stored or
called. `Phone.ts` asks it one question; `publicApi.ts` publishes three exports
onto it.

**`server/services/Phone.ts`** gains one resolution step and loses one special
case.

**`server/lib/publicApi.ts`** publishes `RegisterNumber`, `UnregisterNumber` and
`CreateCall` through the existing `publish` seam, so `publishedExports()` picks
them up and the contract test sees them without a FiveM runtime.

## Call flow

```text
phone:start(targetPhone)
  FrameworkBridge.getPlayerByPhone(targetPhone)     <- players resolve first
    hit  -> existing player path, unchanged
    miss -> numberRegistry.lookup(targetPhone)
              miss -> failUnreachable               <- unchanged
              hit  -> await onCall({ from, source, callId })   [timeout]
                        accept  -> connected, no voice peer
                        reject  -> failUnreachable
                        forward -> re-enter the player path at that source
```

Resolving the player **first** is what implements "the player always wins,
re-checked per call". A number that later becomes a real character's simply
stops reaching the script, with no bookkeeping and no reconciliation step.

`accept` connects the call through the same path a player answering would: it
sets `answeredAt` and emits the existing `callStatus` client events, so the
caller's UI shows a connected call. The only difference is that no second client
is on the other end, so nothing joins pma-voice — the line is silent by
construction, which is what "signalling only" means.

`forward` re-enters the ordinary path rather than running beside it, so voice,
blocking and call logging all behave exactly as a player-to-player call. The
registry is a resolution step, not a parallel call system.

The handler timeout is **five seconds**, long enough for a script doing a
database read and short enough that a caller is not left ringing a dead line. It
is a named constant in `numberRegistry.ts`, not a literal at the call site.

## Pseudo-sources need a pool

`ActiveCall.caller`/`.target` are source numbers and `playerCalls` is keyed by
source. `CONSOLE_CALLER_SOURCE = -1` is a single sentinel, so two players
calling one taxi line at the same time would collide on `playerCalls[-1]`.

Allocate a descending counter from `-2` per active line call and leave `-1` as
the console sentinel it already is. Every existing negative-source behaviour
then holds unchanged: `getCitizenId` returns null, and `logCallEnd` already
skips writing a row for a source with no citizenid behind it.

The invariant to keep: a negative source is never a connected player, and
nothing may pass one to a framework lookup expecting a row back.

## The emergency number

Its only special behaviour today is skipping the block check —
`targetPhone !== emergencyNumber()` at `Phone.ts:230`. "Always connects" means
"is never blockable"; it still fails if nobody holds the number.

That comparison is deleted and becomes `!line?.blockable`. micaOS registers the
emergency convar's number at boot as an unblockable line owned by `mica` with no
handler, so behaviour is identical to today — never blockable, unreachable
unless someone is behind it — until a dispatch resource re-registers it and
supplies one.

## Ownership and lifecycle

`RegisterNumber` records `GetInvokingResource()` as the owner. A second
registration of a held number fails `already_registered`; the same owner
re-registering replaces its own entry, so a script can hot-reload its handler.
`UnregisterNumber` refuses a caller that does not own the number.

**Resource-stop cleanup is new ground** — nothing in this repo listens for it
today. One `onResourceStop` handler in `numberRegistry.ts` drops every number
owned by the stopping resource and ends any active call on those lines through
the existing `endActiveCallFor`. Without it a stopped script leaves a number
that swallows calls into a dead function ref forever, which is the failure mode
function refs trade against.

## Error handling and validation

These are exports, so the caller is another server resource rather than a
client, and §2.9's "trust no NUI payload" does not bite directly. What still
needs checking:

- `forward(source)` and `CreateCall(source, …)` both take a source from a
  script. Both check `isConnected(source)` first, so a stale or invented source
  cannot be dialled.
- Numbers normalise through `phoneNumberFrom` at **registration**, not only at
  dial time, so registry keys cannot drift from lookup keys and a script cannot
  register an unbounded string.
- A handler that throws is caught and treated as `reject`.
- A handler that never returns hits the timeout and falls to `failUnreachable`,
  so a broken integration is indistinguishable from a dead number. This keeps
  the MICA-64 posture that a caller learns nothing about _why_ a call failed.
- Registration refuses a number any character currently holds; the per-call
  player-first lookup enforces it again afterwards.

Failures use the existing `ExportOutcome` shape: `invalid_args`,
`already_registered`, `not_owner`, `number_in_use`, `unknown_player`.

## Testing

New `server/__tests__/numberRegistry.test.ts` covers registration, ownership,
duplicate rejection, collision with a real player, resource-stop cleanup, the
three verdicts, a throwing handler, and a hung handler hitting the timeout.

Existing suites that must **change** rather than merely stay green: the exports
contract test gains three names through `publishedExports()`, and `Phone.ts`'s
emergency-number tests move from asserting the convar comparison to asserting
`blockable`.

`reachability.test.ts` and `eventNames.test.ts` should both come out unchanged —
this adds no net events and no generic actions — and that is worth asserting
deliberately, because it is the evidence that nothing here became
client-reachable.

## What no suite here can prove

That `onResourceStop` fires as expected on a live server, that function refs
survive the cross-resource round trip intact, and that a forwarded call joins
pma-voice correctly. Those need the game, and `pnpm verify` cannot reach them.
