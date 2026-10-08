# A retried seed decides "already there" over every status

MICA-327: a new phone's default-contacts seed was logged and lost when it threw
part-way. The `mica_phones` insert is the "phone is new" mark, and it is written
**before** any hook runs, so it can never also mean "set-up finished". Failed
`onPhoneCreated` hooks are now kept per phone in `Phones.ts` (`owedSetup`) and
retried on that phone's next resolve, backed off like a handover retry.

**Every write that names a holder goes on the phone's queue** (`queueOnPhone`,
the MICA-319 `settling` chain): `ensureHeld`, the first seed, and every retry.
The retry is queued, not awaited, so the next resolve waits behind it. A seed
running outside that queue can race a handover: the new holder's walk moves the
rows, then the seed writes rows naming the old holder, and the new holder is
cached with nothing left to walk (Bly, review). The seed also asks who holds the
phone when it runs (`holderNow`), not who triggered it.

A retried hook must be idempotent, and for contacts the "already there" check
has to read rows **in any status**. `Repository.delete` is soft, so a default
the player deleted still has a row with its number; a read of active rows only
would re-seed it. The read is keyed on `phone_id` alone (server-internal,
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

**Still open:** the debt is process memory. A restart between the failed run and
the retry forgets it; a durable marker needs a column, which is a schema change.

Related: [[negative-check-needs-a-positive-twin]],
[[phones-row-is-one-of-the-walked-tables]]
