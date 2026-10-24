# A deleted ESX citizenid comes back, and the caches and switch gate miss it

On ESX the citizenid is the identifier, and esx_multicharacter hands a deleted
character's `char<slot>:<license>` to the next character created in the slot,
usually on the same source. Two things read that as "nothing changed":

- **Every in-process map keyed by citizenid.** Devices' `identityByCitizen`
  answered the deleted character's phone until a restart, whatever the purge
  erased (MICA-440). Lockscreen's `attempts` kept a lockout.
- **`replacedCharacter` in `lib/shell.ts`.** The same citizenid loading again is
  "the same character picked again", so no `forgetOnPlayerLoaded` forgetter
  runs, and Battery's `loadedFor` skipped the reload: the new character got the
  old phone's live charge, charger still plugged in.

Since MICA-440 the character-deleted hook runs every switch forgetter for each
source whose `loadedCharacter` is the deleted citizenid, then every
`onCharacterDeleted(name, forget)` forgetter, handed a `purged` promise. A new
map keyed by citizenid registers there. One that would refill itself from a row
the purge has not erased yet waits on `purged`, and a read already in flight
must not cache (`forgotten` in `Devices.ts`).

**The mock trap:** a suite that `vi.mock('../lib/shell')` with a factory fails
collection once the module under test calls `onCharacterDeleted` at import
(`phoneNumbers.test.ts` did). Add it to the factory, or capture it.

Tests: `devices.test.ts` "a deleted character (MICA-440)",
`characterSwitchGate.test.ts`, battery, lockscreen and phoneNumbers suites;
`scripts/test-schema.js` `runCharacterRecreatedVariant` on both shapes.

**Two more from the review round.** `findIdentity` created a phone for any
citizenid, so after the purge an export naming the deleted id made a fresh live
phone the next ESX character inherited. The cold create now asks
`characterExists` (orphanSweep.ts, the sweep's own owner table) unless the
caller vouches for a loaded player; `offlineLookup` folds a failed read into
`null`, so it cannot answer "absent". And reordering the sweep's erase (`first`)
must not reorder what `resolveOwner` samples: sampling `mica_devices` first
refused the harness's sweep as `identity-mismatch`, because its only phone rows
were the deleted character's. Only `test:schema` saw it; `orphanSweep.test.ts`
pins the sampled table now.
