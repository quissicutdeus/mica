# A held core object's funcrefs are live, its data fields are not

`GetCoreObject()` and ESX's `getSharedObject()` cross the export boundary as a
msgpack copy. Holding the copy is safe for its functions, which call back into
live state, but every plain field on it is a snapshot: `ESX.Players` on a held
copy lists players who have left, on server ids that may already belong to
someone else, which is misdelivery.

**How to apply:** when holding a core object (MICA-351's `heldUntilRestart`),
grep every use of it and read only funcrefs off the held copy. A data field must
come from a fresh fetch. Do not hold a copy that lacks the functions you are
about to call; it may have been fetched mid-start.
