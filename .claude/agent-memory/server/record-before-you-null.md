# Record a value from a column in the same UPDATE that nulls it: assign it first

MICA-350 records the leaving phone's number in `absent_number` in the same
statement that nulls `participant_a`/`participant_b`. `releasePairsOf` and
migration 0009 read the leaving phone off `c.participant_a`/`c.participant_b`
inside that statement. `releasePair` does not: it binds the device id. MariaDB
evaluates a single-table `UPDATE … SET` left to right, and a later expression
sees the new value of an earlier column. So in the two that read the columns,
`absent_number = …` must come first in the `SET` list. Put it after the nulling
and every subquery matches NULL, which records NULL everywhere, with no error.

No unit suite can see the order, because they all stub `Database`.
`pairRelease.test.ts` asserts the position in the SQL text. `test:endpoints`
(`leftThread`, `privacy`) and `test:migrations` (0009 fixture) show it against
MariaDB 11.

Two more traps from the same change:

- **An amended migration's fixture imports the schema that already has the
  column.** The 0009 fixture drops `absent_number` after the import, so it
  actually runs the migration's `ADD COLUMN`. Without the drop, the "adds the
  column" half never runs.
- **A number from outside `mica_phone_numbers` can be wider than 16.** That
  includes an ESX framework number, a dialled one (up to 32 by contract), or a
  stored value. `absentNumberFrom` turns one that is too wide into NULL. Writing
  it would fail the release under strict mode.

Related: [[unpaired-thread-needs-coalesce]], [[oxmysql-errors-carry-no-errno]]
