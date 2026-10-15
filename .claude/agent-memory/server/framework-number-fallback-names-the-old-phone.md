# The framework-number fallback names the phone you just put down

Traced for MICA-343 and fixed for MICA-346. On qb and standalone,
`FrameworkBridge.getPlayerPhone(src)` and `getPlayer(src).phone` answer from
`numberFor(citizenid)` or `charinfo.phone`. That is the number of the **last
phone the sync settled**. After a switch to a burner with no row yet,
`syncNumber` is still in flight, so the burner's call or text carried the main
number. If `assign` gave up, it carried it for good.

The fallback is right only on ESX. ESX has no rows, and the number is the
character's.

**The rule now lives in `numberOfPhone` (`lib/phoneNumbers.ts`).** A call, a
text, a listing, a live-location share and a line's `forward` all use it:

1. ESX: the framework number.
2. The device's own row.
3. `await syncNumber(src)`, then the legacy row, then the device's row again.
4. Otherwise null.

**A sync picks the phone when it starts, so a trigger must not join one already
running.** Until MICA-346, `syncNumber` joined any pending run for the same
citizen. A burner used during the main phone's load sync was then never synced.
Now a trigger queues one run behind the running one, and later triggers join
that queued run. A "same phone" join would need Devices' slot rule copied into
PhoneNumbers, and a copy that drifts reopens the bug without any error. The
queued run is all cache when nothing changed. Tested in `phoneNumbers.test.ts`
("numbers a burner swapped in mid-sync").

**Still never use `syncNumber`'s return value as "this phone's number".**
`numberOfPhone` reads the row keyed by the phone's id. The
`numberOfPhone.test.ts` and MICA-346 cases in `phone.test.ts` mock the sync to
answer the main number and write nothing.

**Read the legacy row after the sync, not before.** On a first-ever load, the
legacy row is still `device_id IS NULL` while the main phone's sync attaches it.
Read early, it names the main phone.

`lib/phoneNumbers.ts` cannot import `FrameworkBridge` (which imports it) or
`services/PhoneNumbers` (a lib-to-service cycle). So callers pass
`{ framework: detectFramework(), sync: syncNumber }` in.

**Still on the framework number, deliberately:** `ringGroup`'s candidate number
and `injectIncomingCall`'s `targetPhone`. Both only pick which phone a row is
filed on, and neither reaches another player.

**Test fixtures:** `phone.test.ts` now defaults to `framework: 'esx'`, because
its `phones` map is "each player's own number". Suites that drive `send`,
`create` or `startSharing` on qb need a number-row answer from `Database.single`
and a mocked `../services/PhoneNumbers`. Without the mock, the real sync runs
against the stubs.

Importing `services/Devices` to ask `resolvePhone` directly is a trap here. It
calls `installDeviceResolvers` at import. `setup.ts` re-installs the test phone
in a global `beforeEach`, so this bites only resolvers a suite installs at
module scope.
