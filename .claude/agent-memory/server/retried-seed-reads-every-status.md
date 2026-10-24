# A retried seed decides "already there" over every status

MICA-327: a new phone's default-contacts seed was logged and lost when it threw
part-way. The `mica_devices` insert is the "phone is new" mark, and it is
written **before** any hook runs, so it can never also mean "set-up finished".
Failed `onDeviceCreated` hooks are now kept per phone in `Devices.ts`
(`owedSetup`) and retried on that phone's next resolve, backed off like a
handover retry.

**Every set-up run goes on the device's queue** (`queueOnDevice`, the MICA-319
`settling` chain): the first seed and every retry, so two runs never overlap and
double an idempotent hook's rows. Queued, not awaited. Until MICA-436 the queue
also held `ensureHeld`, because a seed outside it could race a handover's walk
(Bly, review). Since MICA-438 no resolve joins the queue: a resolve reads only
its own citizen's row, which no hook changes, and the hook is handed the owner.

A retried hook must be idempotent, and for contacts the "already there" check
has to read rows **in any status**. `Repository.delete` is soft, so a default
the player deleted still has a row with its number; a read of active rows only
would re-seed it. The read is keyed on `device_id` alone (server-internal,
decides what to insert). Numbers compare by digits (`sameNumberKey`), mirroring
the web caller-ID rule `contactRingtone` in `toast.ts`; no shared helper exists
yet.

**Why not one transaction with the phone row:** `defaultContacts.test.ts` pins
two MICA-234 properties — seeding never holds up the phone, and never fails it —
and putting the phone row in the seed's transaction breaks both.

**Trap in the test:** an in-memory mock that ignores the SQL's `WHERE` cannot
catch a wrong status filter. `defaultContactsRetry.test.ts` honours a status
predicate on purpose; with it, an active-only read fails exactly the "deleted
default" case.

**Durable since MICA-335.** `mica_devices.setup_pending` (`DEFAULT 0`, so every
pre-existing row reads as done; every insert writes `1`) is cleared after the
last hook, and the first resolve after a start re-arms every hook from it
(`resumeSetup`). `announceCreated` puts the phone in `owedSetup` before its
first run, so a read of the row mid-run is not taken for a restart's leftover.
Each seeded contact carries `default_number`, which the player cannot edit, so a
renumbered default is not re-added.

Related: [[negative-check-needs-a-positive-twin]],
[[a-foreign-read-skips-the-owners-read]]
