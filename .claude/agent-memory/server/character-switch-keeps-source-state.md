# A character switch reuses the source and never fires playerDropped

A multichar logout and pick loads a second character on the **same source**.
`playerDropped` does not fire, and micaOS has no character-unload hook, so any
map keyed by source and cleared only on drop still holds the previous
character's state when `onPlayerLoaded` runs again.

Battery's `phoneOf` was one of these (MICA-326 review): `phoneForSource` answers
from it without asking, so the new character loaded, ticked and saved the
previous character's phone. It is fixed by forgetting the source at the top of
the `onPlayerLoaded` subscriber.

MICA-336 audited the rest and added `forgetOnPlayerLoaded` to `lib/shell.ts`: a
phase that runs every forgetter before any subscriber, because subscribers run
in import order and one resolving a device ahead of the forget reads the old
slot. On it: `deviceItem.ts`'s `lastUsed`, Phone's call and speaker, and Music's
broadcast. Three traps found on the way:

- **A load is dispatched more than once, minutes apart.** qbx fires the local
  `QBCore:Server:PlayerLoaded` inside its character load and the network
  `OnPlayerLoaded` only when the player confirms a spawn in qbx_spawn, with no
  time limit. The character is loaded and callable on that screen, so the first
  cut (forget on every dispatch) ended a call answered there (review, Wolffe).
  Forgetters now run only when the loading citizenid differs from shell's own
  `loadedCharacter` record. **Not** `FrameworkBridge`'s source registry: that is
  rebuilt from the framework on any lookup miss, and qbx empties
  `QBX.Players[src]` at logout and seats the new character before announcing it,
  so a rebuild either forgot who left or recorded the new one early (Wolffe
  re-review). A cache something else can rebuild is not a record of the past.
  Battery's switch is a gated forgetter too; its subscriber skips the reload for
  the character `loadedFor` already holds (a reload put the saved row back over
  the live charge and unplugged the charger).
- **A sync started for one character outlives the switch.** Re-check the
  source's citizen after every await; qbx's `SetCharInfo` is addressed by
  source, so a finished stale run wrote the old number onto the new character.
- **Code that names a source at the end of something reads the new character.**
  `logCallEnd` calls `getCitizenId(src)` when the call ends, so ending the old
  character's call at the load filed it in the new one's call log. The forgetter
  is handed the previous citizenid, and the row is filed under it.
- **A push-dedupe cache is the connection's, not the character's.** The client
  has no unload handler, so Music and Signal `lastPushed` must survive a switch.
  Forgetting Music's would skip the "stereo stopped" push to that client.

`SetSignal` overrides and LockState's `source:` keys are cleared on a switch too
(the owner's ruling: they are set for a character's reason). Left on purpose:
`PhoneOpenState`, which mirrors the client's NUI.

A test for this drives the local `QBCore:Server:PlayerLoaded` handler twice with
`getPlayer` answering a different citizenid the second time. Other subscribers
(the device-item pass) also run, and can mask the bug by reloading on their own.
Assert on the case where their reload cannot rescue it.
