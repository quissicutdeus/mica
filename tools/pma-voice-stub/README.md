# pma-voice-stub

A dev-only stand-in for [pma-voice](https://github.com/AvarianKnight/pma-voice),
for testing calls in game with one player (MICA-55). Not a working voice
implementation — it does no actual audio routing. What it models is how a player
gets into a call channel.

Since MICA-341 micaOS's **server** puts both parties of a call in its channel
through pma-voice's `setPlayerCall` export, and takes them out on every end
path; the client never joins by itself. `server.lua` stubs that export and also
the `pma-voice:setPlayerCall` net event, which in the real pma-voice lets any
client join any channel unchecked. The stub leaves it just as open, and prints a
warning whenever a client joins a channel that way. That line is how you see a
client joining by itself, which micaOS's own client no longer does. It is also
how you see micaOS putting such a client back out.

## Running it

1. Copy this folder into your FiveM server's `resources/` directory, **named
   `pma-voice`** — a FiveM resource's export namespace is its folder name, not
   anything inside `fxmanifest.lua`, so it has to replace the real one by name
   for `exports['pma-voice']` to resolve to it.
2. Do **not** also run the real pma-voice at the same time — whichever starts
   last wins the export namespace, and you want this one to.
3. `ensure pma-voice` before `ensure mica` in your `server.cfg`, same ordering
   the real resource needs.
4. Watch the server console. `micacall [number]` (AGENTS.md §1) rings yourself;
   answer it and confirm `setPlayerCall(<you>, <call id>) by mica` printed; hang
   up (or have the simulated peer's side end it) and confirm
   `setPlayerCall(<you>, 0) by mica` printed too. No "joined call … by its own
   client" line means the client never joined by itself, and no "moved from call
   … without leaving it first" means nothing leaked.
5. To watch the refusal, send `pma-voice:setPlayerCall` with a live call's id
   from a client micaOS did not place in it: a second player, or yourself while
   `micacall` is still ringing, since a ringing target is not placed. The stub
   prints the forged join, then `setPlayerCall(<them>, 0) by mica` taking it
   back.

## What this does not catch

Nothing here proves audio actually reaches anyone — that needs a real voice
resource and a second person, and there is no way around that
(`docs/testing-voip.md` says more about why). Nor can it show how long a forged
join lasts before micaOS undoes it: that depends on the order FiveM runs the two
resources' handlers, which only a real server shows. This is one layer below
that: does micaOS put the right players in the right channel and take them out
again, every time.

## Never ship this

This folder is not referenced by `fxmanifest.lua`, `build/build-bundle.js`, or
anything under `dist/` — it is not part of the `mica` resource and never reaches
a player who installs it. Keep it that way: it exists to be dropped into a
**dev** server's `resources/` folder by hand, and nowhere else.
