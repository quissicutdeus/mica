# pma-voice-stub

A dev-only stand-in for [pma-voice](https://github.com/AvarianKnight/pma-voice),
for testing calls in game with one player (MICA-55). Not a working voice
implementation — it does no actual audio routing. What it does is print every
call gPhone's client makes to `exports['pma-voice']`, and flag it loudly if
`addPlayerToCall`/`removePlayerFromCall` are ever called out of balance, which
is the channel-leak class of bug this exists to catch — see
`client/__tests__/Call.test.ts` for the same check against a mocked client.

## Running it

1. Copy this folder into your FiveM server's `resources/` directory, **named
   `pma-voice`** — a FiveM resource's export namespace is its folder name, not
   anything inside `fxmanifest.lua`, so it has to replace the real one by name
   for `exports['pma-voice']` to resolve to it.
2. Do **not** also run the real pma-voice at the same time — whichever starts
   last wins the export namespace, and you want this one to.
3. `ensure pma-voice` before `ensure gphone` in your `server.cfg`, same ordering
   the real resource needs.
4. Watch the server console. `gphonecall [number]` (AGENTS.md §1) rings
   yourself; answer it and confirm `addPlayerToCall` printed with the right call
   id; hang up (or have the simulated peer's side end it) and confirm
   `removePlayerFromCall` printed too. No "already in a call" or "called with no
   call joined" warning means nothing leaked.

## What this does not catch

Nothing here proves audio actually reaches anyone — that needs a real voice
resource and a second person, and there is no way around that
(`docs/testing-voip.md` says more about why). This is one layer below that: does
the client hold up its end of the pma-voice contract, symmetrically, every time.

## Never ship this

This folder is not referenced by `fxmanifest.lua`, `build/build-bundle.js`, or
anything under `dist/` — it is not part of the `gphone` resource and never
reaches a player who installs it. Keep it that way: it exists to be dropped into
a **dev** server's `resources/` folder by hand, and nowhere else.
