# pma-voice's call join is unchecked; micaOS undoes it

pma-voice's `pma-voice:setPlayerCall` net event (`server/module/phone.lua` 74-76
in `/opt/fivem/server-data/vendor/pma-voice`) hands any client's channel
straight to `setPlayerCall`. Only radio has `addChannelCheck`; calls have no
check at all. Since MICA-341 `Phone.ts` places and removes the parties through
the server export, and an `onNet` on that same event puts a client back when it
is in a live call's channel it was not placed in. The check runs at once and
again on the next tick, because the order of the two resources' handlers is
unknown.

The traps:

- Read the channel back from `Player(src).state.callChannel`, never from the
  payload. Lua's `tonumber` reads `"0x1p4"` as 16, while JS `Number` gives NaN.
- Do not put a guard on someone else's event through `guardNetEvent`. Its rate
  limit would stop answering after 60 a minute, and a client looping the join
  would then stay in.
- Never call `setPlayerCall` for a source that has just dropped. pma-voice's own
  `playerDropped` deletes its voice state, and the call recreates it.
- Any new raw `onNet`, a foreign name included, fails
  `server/__tests__/netGuardCensus.test.ts` in 9 places. That covers the
  `netGuard.ts` docblock, the framework-named list, the `INLINE` exemption and
  `docs/security.md`. Report it as a cross-fence edit.

What no suite shows is how long a forged join lasts before it is undone.
