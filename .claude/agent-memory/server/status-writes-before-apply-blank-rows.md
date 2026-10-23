# A status write before micaschema apply can blank the row

Code ships before the owner runs `micaschema apply`. Until then, a status the
new code writes (`expired`, `erased`) may be missing from the live ENUM:

- Under `STRICT_TRANS_TABLES` the write is refused, and a `.catch(() => {})`
  hides the refusal.
- Under `sql_mode=''` MariaDB stores `''` with warning 1265, and the row's
  status is gone for good.

Found by replaying 0013–0016 on a copy of a live database. `Notifications.ts`
called `pruneStale` at module import, so the first start on new code blanked
every old notification.

Every write that moves a status on its own schedule now asks
`statusWritesMayRun(job, { table: [statuses] })` first (`lib/statusWrites.ts`).
That covers sweeps, prunes, retention, the purges, the dependent erase and
`writeVersioned`. The check fails closed when:

- a migration on disk is missing from the ledger;
- a status the job writes is missing from its table's ENUM;
- the table has no status column at all;
- the check itself cannot read the database.

A held job logs once, naming `micaschema apply`. `runApply` resets the check.

A new sweep must ask the same question; nothing enforces it yet. The unit suites
assume a current database through a `VITEST` default. Only `test:migrations`'s
`runHeldBeforeApply` (a pre-0015 table under `sql_mode=''`) proves the hold.

The gate module cannot import `lib/migrations.ts`, because that reaches
`Repository`. See [[start-gate-import-cycle]].
