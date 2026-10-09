# Testing calls solo

MICA-55. Every other feature in this phone has a solo path — `micaseed` in game,
the mock transport in a browser — because a real second player is expensive to
arrange for every change. Calls didn't, for two structural reasons:
`server/services/Phone.ts`'s `start` handler refuses a self-call as "Busy", and
`FrameworkBridge.getPlayerByPhone` only ever finds someone online, so a
`micaseed` character can be texted and never called.

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
`micacall` (below) is a thin command wrapper around — so the harness `micacall`
gives you in game has a matching, faster harness here first.

**Stops at:** the server's own bookkeeping. Proves the state machine is correct;
proves nothing about whether a real client reacts to any of it.

## Layer 2 — UI and lifecycle, no game

`web/src/nui/mocks/services/phone.ts`'s `startCall`/`endCall`/`answerCall`/
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

- **`micacall`** (`server/services/Phone.ts`, `AGENTS.md` §1) —
  `micacall [number]` or `micacall <firstname>` (a `micaseed` character) rings
  yourself; `micacall end` force-ends it. Fakes only the peer (a synthetic
  source, `CONSOLE_CALLER_SOURCE`, that can never collide with a real player)
  and drives the rest of the real path: NUI focus, the `callStatus` messages,
  and — answering it for real — the server placing both parties in the call
  channel (MICA-341). Settings > Developer Tools' "Simulate Incoming Call"
  routes through the same mechanism in game
  (`mica:server:phone:simulateIncoming`); in a browser it still fakes the toast
  locally, since there's no server to ask.
- **`tools/pma-voice-stub/`** — a dev-only FiveM resource, _not_ part of this
  one, that stands in for pma-voice. Since MICA-341 it has a server half too: it
  prints every server `setPlayerCall`, which is how micaOS now puts both parties
  into a call and takes them out, and its client half still prints
  `setPlayerTalkingOverride`. See its own `README.md` for how to run it.

Ring yourself, answer, hang up, and watch the stub's server console for a
`setPlayerCall` to the call's channel for each party, then one back to `0` for
each when the call ends.

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

Mute is `setPlayerTalkingOverride` and nothing more (`client/services/Call.ts`),
so no layer above tests what it does to audio. Speakerphone has its own section
below, because it does route audio and so has a manual test of its own.

## Speakerphone: what pma-voice allows

MICA-246. Read from pma-voice 7.0.1's own source (`server/module/phone.lua`,
`client/module/phone.lua`, `client/init/main.lua`, `client/init/proximity.lua`,
`client/init/submix.lua`) and from the natives `@citizenfx/client` 2.0.34410-1
declares, not from its docs.

**What a call is in pma-voice.** A call channel is a set of server ids. The
server export `setPlayerCall(source, channel)` adds a player to one (`0` removes
them); called from another resource it also tells that player's pma-voice client
its channel and writes `Player(source).state.callChannel`. Every member targets
every other member's voice (`MumbleAddVoiceTargetChannel`), and plays theirs
with `MumbleSetVolumeOverrideByServerId` at the listener's own call volume (one
number per client, `setCallVolume`/`getCallVolume`, default
`voice_defaultCallVolume` 60) through the `Call` submix. With
`voice_enableCalls` off, `setPlayerCall` returns without doing anything.

**Viable today: nearby players join the call channel.** The server adds anyone
within `mica_speaker_range` of a phone on speaker to that call's channel, and
takes them out when they walk away (past 1.25x the range), start a call of their
own, the speaker goes off, or the call ends. Joining is two-way by construction,
so the far side hears them. Each bystander's own client lowers its call volume
to `mica_speaker_volume` while it listens and restores it after — "reduced
volume" is per listener, not per talker, because pma-voice has one call volume
per client. `server/lib/speakerphone.ts` is the implementation.

**What this is not.** The far side is heard in the bystander's ear through the
`Call` submix, not from where the phone is. Bystanders also hear the phone's
holder and each other through the call, at that same volume, on top of plain
proximity. And a bystander is a transmitter: while they are in range, anything
they say reaches the far side, which is what a speakerphone is.

**Not possible with the release client: a true positional speaker.** That needs
the far side's voice to come _out of the phone_ for everyone near it, and the
far side to hear the room through the phone's microphone. No native does either.
`MumbleSetSubmixForServerId` only filters a talker,
`MumbleSetVolumeOverrideByServerId` only sets their level, and the submix
natives (`CreateAudioSubmix`, `SetAudioSubmixEffect*`,
`SetAudioSubmixOutputVolumes`) shape output channels — nothing sets a remote
Mumble talker's 3D position to another entity, and nothing mixes game audio into
the outgoing voice stream. It would need a native like "play server id X's voice
at entity Y" that FiveM does not ship.

**Honest toggle.** The server offers the speaker with each call's `accepted`
push (`speaker: true|false`), and the phone shows the control only when it was
offered: pma-voice started, `voice_enableCalls` on, `mica_speaker_range` above
`0`, and the call is between players (a line's far end has no voice). The toggle
is the contracted `phone:speaker` action, and the phone shows the server's
answer rather than its own guess.

**A pma-voice hole micaOS narrows but cannot close (MICA-341).** pma-voice's
`pma-voice:setPlayerCall` net event takes any channel from any client with no
check (`server/module/phone.lua`). micaOS now places both parties itself, and
listens to that event: a client found in a live call it was not placed in is put
back, for up to about one server tick of overhearing. Closing it fully is
pma-voice's business (its `addChannelCheck` covers radio channels only).

### Manual test — three people, in game

Needs the real pma-voice, not `tools/pma-voice-stub/`: the stub's server half
only prints `setPlayerCall`, so nobody actually hears anybody. Three players A,
B and C on the same server; `voice_debugMode 4` on the server prints pma-voice's
`[call] Added`/`Removed` lines.

1. A calls B; B answers. **Both** phones show Speaker. On a server without
   pma-voice, or with `set mica_speaker_range 0`, neither does — the row shows
   Mute and Keypad only.
2. C stands within 4 m of A, well away from B. A taps Speaker; it lights. Within
   a second the server console logs C added to the call. C hears B, B hears C,
   and C's call volume is quieter than a normal call.
3. C walks 6 m away: removed within a second, B stops hearing C. C walks back:
   added again.
4. A taps Speaker off: C removed. On again: C added.
5. B hangs up: C removed along with the call. C then makes an ordinary call of
   their own and hears it at their usual volume — the saved volume came back.
6. With C listening, ring C (`micacall` from an admin C works): C drops out of
   A's call as soon as their own phone rings, without their own call being
   touched when it connects.
7. With C listening, `restart mica`: C removed, volume restored.

What to watch for that no suite catches: C still hearing B after any of steps
3-7, C's call volume staying low after step 5, or B hearing C at step 2 not at
all (the join is two-way; one-way audio means pma-voice's targets did not
update).
