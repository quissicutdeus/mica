# The framework-number fallback names the phone you just put down

Traced for MICA-343. Rex is filing the shared fix as its own ticket.
`callerNumberOf` in `services/Phone.ts` reads the phone in hand's own
`mica_phone_numbers` row, then falls back to
`FrameworkBridge.getPlayerPhone(src)`. Messages' `senderPhone` skips the row and
reads `getPlayer(source).phone` directly.

On qb and standalone, both fallbacks answer from `numberFor(citizenid)` or
`charinfo.phone`. That is the number of the **last phone the sync settled**.
After a switch to a burner with no row yet, `syncNumber` is still in flight: a
few round trips, or for good if `assign` gives up. Until it lands, the burner's
call or text carries the main number.

The fallback is right only on ESX (no rows; the number is the character's) and
on an identity phone (its number is a legacy row with `device_id IS NULL`, so
`readRowByPhoneId` misses).

**What Marketplace does instead** (`numberToRecord`, since a listing stores the
number for good):

1. The device's own row.
2. On ESX, the framework number.
3. On qb and standalone, the citizen's legacy row. The first phone synced takes
   that row, so it never names another phone of theirs.
4. Otherwise null.

Its burner case is pinned in `Marketplace.test.ts`. The contact share dropped
its sender entirely.

Importing `services/Devices` to ask `resolvePhone` directly is a trap here. It
calls `installDeviceResolvers` at import, which replaces `phoneStub`'s resolvers
in every suite that imports the importer.

**Candidate shared fix.** `await syncNumber(src)` joins the in-flight sync and
returns the number of the phone in hand on qb and standalone. Fall back to the
framework number only when `detectFramework() === 'esx'`.
