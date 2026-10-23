# An erase is not one statement shape for every table

MICA-428 turned every purge into
`UPDATE t SET status = 'erased', updated_at = updated_at WHERE … LIMIT n`. The
unit suite passed with that shape on every owned table. Three MariaDB harnesses
then found three tables it was wrong for:

- **`test:schema`: a child table may have no `updated_at`.**
  `mica_darkchat_members` declares a status and no `updated_at`, so pinning it
  is `Unknown column 'updated_at' in 'SET'`, and the table fails on every purge.
  `hasUpdatedAt` in `sweep/tables.ts` now reads the declaration.
- **`test:endpoints`: membership is `left_at IS NULL`, not `status`.** Every
  membership read (a 1:1's pair in `findOneToOne`, a thread's members, Dark
  Chat's `live_citizen` and `alias_key`) asks `left_at`. An erased membership
  with `left_at` NULL kept the erased player in every thread. The erase of a
  membership table now also sets `left_at = COALESCE(left_at, NOW())` (`leaving`
  in `sweep/purge.ts`, from `registerSharedRows`).
- **`test:migrations` on ESX: a generated copy of `citizenid` takes its width.**
  0015 restated `mica_spark.live_citizen` as `varchar(50)`, but ESX's
  `citizenid` is 60 after 0004, so the upgraded column disagreed with a fresh
  import. The migration now reads the table's own `citizenid` type.

The stub `Database` sees none of these: it answers any column name and has no
membership semantics. A status change across every table needs all three
harnesses, not one.

Related: [[migration-virtual-column-and-fill-traps]],
[[replay-captured-sql-on-mariadb]].
