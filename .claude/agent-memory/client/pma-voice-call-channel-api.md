# What pma-voice's call channels can and cannot do

Read from pma-voice 7.0.1's source under `/opt/fivem/server-data/vendor/` for
MICA-246. `docs/testing-voip.md` has the full note; these are the parts a future
change to `client/services/Call.ts` trips over.

- **Call volume is one number per client**, not per talker:
  `setCallVolume`/`getCallVolume` exports, applied to every call member through
  `MumbleSetVolumeOverrideByServerId`. Lowering it for one listener means saving
  and restoring it.
- **`setPlayerCall(source, channel)` from another server resource** also tells
  that player's pma-voice client its channel (`pma-voice:clSetPlayerCall`) and
  writes `Player(source).state.callChannel`, so the server can read membership
  back from the state bag.
- **The client export `addPlayerToCall(id)`** is just `setCallChannel`, which
  fires the unguarded net event `pma-voice:setPlayerCall`. Any client can join
  any channel; that hole is pma-voice's, not ours.
- **No native moves a remote talker's voice to another entity** and none mixes
  game audio into the outgoing stream (checked against `@citizenfx/client`
  2.0.34410-1's Mumble and submix declarations). A positional speakerphone is
  not buildable on the release client.
- **`tools/pma-voice-stub/` has no server half**, so anything that calls the
  server export `setPlayerCall` cannot be exercised with it.

**Why:** each of these would otherwise be rediscovered by reading Lua, and the
first two decide how a feature that touches call audio has to be shaped.

**How to apply:** before changing call audio, re-check the vendored version in
its `fxmanifest.lua`; these hold for 7.0.1.
