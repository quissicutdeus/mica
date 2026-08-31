# Testing calls solo

MICA-55. Every other feature in this phone has a solo path — `gphoneseed` in
game, the mock transport in a browser — because a real second player is
expensive to arrange for every change. Calls didn't, for two structural reasons:
`server/services/Phone.ts`'s `start` handler refuses a self-call as "Busy", and
`FrameworkBridge.getPlayerByPhone` only ever finds someone online, so a
`gphoneseed` character can be texted and never called.

Most of what actually breaks in a call needs neither a second player nor the
game. This is the map of what each layer catches and, just as importantly, where
it stops — read that half before trusting a green layer to mean more than it
does.

## Layer 1 — signaling and the call log, no game

`server/__tests__/phone.test.ts`. Mocks `FrameworkBridge` with two fake sources,
captures the raw `onNet` handlers `Phone.ts` registers at import, and calls them
directly — milliseconds, no FiveM runtime. Covers the state machine itself:
busy, line-busy, an unknown number, `playerDropped` mid-call, and `logCallEnd`'s
caller-always-`outgoing` / target-`incoming`-or-`missed` rule.

This is also where `injectIncomingCall`/`endActiveCallFor` live — the functions
`gphonecall` (below) is a thin command wrapper around — so the harness
`gphonecall` gives you in game has a matching, faster harness here first.

**Stops at:** the server's own bookkeeping. Proves the state machine is correct;
proves nothing about whether a real client reacts to any of it.

## Layer 2 — UI and lifecycle, no game

`web/src/nui/mocks/registry.ts`'s `startCall`/`endCall`/`answerCall`/
`rejectCall` play the same lifecycle on a timer — ring, then connect or give up
— posting the same `callStatus` window message the real client forwards from the
server, rather than answering the NUI callback and doing nothing.
`web/e2e/apps/phone.spec.ts` drives it through Playwright: dial → connects →
hang up → logged in Recents; dial an unreachable number → logged `outgoing`,
zero duration, no error styling (not `missed` — that's the _target's_ row, never
the caller's own); decline an incoming call → logged `missed`.

Also where `pnpm dev` and the demo container get their call behavior from —
before this, a dialed call there never rang and never connected.

**Stops at:** everything downstream of `window.postMessage`. Proves the UI
reacts correctly to the messages the real client would send; proves nothing
about pma-voice, since the mock never touches it — there is no `exports` global
in a browser to call.

## Layer 3 — the pma-voice contract, one player, in game

Two pieces, meant to be used together:

- **`gphonecall`** (`server/services/Phone.ts`, `AGENTS.md` §1) —
  `gphonecall [number]` or `gphonecall <firstname>` (a `gphoneseed` character)
  rings yourself; `gphonecall end` force-ends it. Fakes only the peer (a
  synthetic source, `CONSOLE_CALLER_SOURCE`, that can never collide with a real
  player) and drives the rest of the real path: NUI focus, the `callStatus`
  messages, and — answering it for real — the pma-voice join. Settings >
  Developer Tools' "Simulate Incoming Call" routes through the same mechanism in
  game (`gphone:server:phone:simulateIncoming`); in a browser it still fakes the
  toast locally, since there's no server to ask.
- **`tools/pma-voice-stub/`** — a dev-only FiveM resource, _not_ part of this
  one, that stands in for pma-voice: prints every `setPlayerTalkingOverride`/
  `addPlayerToCall`/`removePlayerFromCall` call, and flags it loudly if
  `addPlayerToCall`/`removePlayerFromCall` are ever called out of balance — the
  channel-leak class of bug `client/__tests__/Call.test.ts` checks against a
  mocked client. See its own `README.md` for how to run it.

Ring yourself, answer, hang up, watch the stub's console output for a clean
`addPlayerToCall` → `removePlayerFromCall` pair with no imbalance warning.

**Stops at:** whether the client holds up its end of the pma-voice contract.
Proves the join/leave calls happen, symmetrically, against the real client;
proves nothing about whether pma-voice itself does anything useful with them,
and nothing about audio.

## Layer 4 — audio actually being audible

No way around this one: pma-voice and Mumble have no self-loopback, and FiveM is
one instance per machine. Needs a second person, or a second machine on the same
server. Run it last, as confirmation once the three layers above are already
clean — not as the loop you debug in, since it is the slowest and least specific
one by far.

## What none of the four cover

Speakerphone and mute are UI state only — `client/services/Call.ts:73`:
pma-voice exposes no speakerphone/submix control, so `toggleSpeaker` never
reaches it at all, and `toggleMute` only ever calls `setPlayerTalkingOverride`.
No layer above tests actual audio routing for either, because there is nothing
on the pma-voice side for them to route.
