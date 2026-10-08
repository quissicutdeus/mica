# A character switch reuses the source and never fires playerDropped

A multichar logout and pick loads a second character on the **same source**.
`playerDropped` does not fire, and micaOS has no character-unload hook, so any
map keyed by source and cleared only on drop still holds the previous
character's state when `onPlayerLoaded` runs again.

Battery's `phoneOf` was one of these (MICA-326 review): `phoneForSource` answers
from it without asking, so the new character loaded, ticked and saved the
previous character's phone. It is fixed by forgetting the source at the top of
the `onPlayerLoaded` subscriber. `deviceItem.ts`'s `lastUsed` slot map is
cleared only on drop too, which is still open.

A test for this drives the local `QBCore:Server:PlayerLoaded` handler twice with
`getPlayer` answering a different citizenid the second time. Other subscribers
(the device-item pass) also run, and can mask the bug by reloading on their own.
Assert on the case where their reload cannot rescue it.
