# Redefine a virtual column by drop and add; pin updated_at in a fill

Two traps MICA-432's 0014 hit. Only `pnpm test:migrations` showed them; the unit
suite stubs `Database` and saw neither.

**`MODIFY` of a VIRTUAL generated column fills it with garbage.** On MariaDB 11,
redefining `phone_key` (`MODIFY COLUMN … GENERATED ALWAYS AS (…) VIRTUAL`) to
read `phone_index` failed intermittently with
`Incorrect string value: '\x8F\xF0x…' for column phone_key at row 0`. The bytes
were uninitialized memory, and the failure was not deterministic: it passed one
run and failed the next. Two changes fixed it:

- drop the unique key, `DROP COLUMN`, then `ADD COLUMN` with the new expression,
  then add the key back (a virtual column holds nothing to lose);
- put the base column the expression reads **before** it
  (`ADD COLUMN … AFTER phone`). The declarations do the same: `defineService`
  splices `<col>_index` right after its value.

**An `UPDATE` that fills a new column moves `updated_at`.** Every table with
`ON UPDATE CURRENT_TIMESTAMP` stamps every filled row with the moment of the
migration. Threads sort by it, and `updated_at > created_at` reads as "edited".
Write `, updated_at = updated_at` in every fill (0014's `pin()`), as the
backfill does.

A harness regression that seeds the ledger and deletes one migration's row must
delete the rows of any later migration that rebuilds the same thing. 0010's
scenario had to drop 0014 too, or 0010 rebuilt the old `phone_key` and 0014
never ran.

Related: [[apply-runs-migrations-before-creates]],
[[additive-column-trips-widen-resume]].
