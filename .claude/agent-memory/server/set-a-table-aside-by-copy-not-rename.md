# Set a table aside by copy, not by rename

An in-server scenario that needs a micaOS table missing (to watch
`micaschema apply` create it, MICA-388/389) must keep its rows and put them
back. `RENAME TABLE t TO t_bak` looks like the clean way. It is not: InnoDB
foreign key **constraint names are unique per schema**, the renamed table keeps
its `fk_mica_…` names, and apply's `CREATE TABLE IF NOT EXISTS` for the same
declaration then fails on a duplicate constraint name (errno 121). The scenario
would report apply broken when the harness is.

What `integration/scenarios/schema.ts` does instead (`withTablesDropped`):

- Save `SHOW CREATE TABLE`, the next `AUTO_INCREMENT`, the shape from
  `information_schema`, and the rows via `CREATE TABLE itx_… AS SELECT *` (a
  copy carries no constraints or indexes, so it collides with nothing).
- Drop children first; a parent cannot be dropped while anything still
  references it, so the set must include every referencing table.
- Restore whatever happened: recreate from the saved DDL if still missing,
  clear, refill naming only non-generated columns
  (`EXTRA NOT LIKE '%GENERATED%'`; a generated column refuses an insert), reset
  `AUTO_INCREMENT`, drop the copy. Report a restore failure beside the
  scenario's own error, never over it.

Second trap from the same lane: emptying the ledger reruns every migration on
live data, and 0009/0010/0011 issue UPDATEs that no restore undoes. Clear only
`^[0-9]{4}_` ids; the content-cipher and retention markers are not migrations
and stay.

Unproven until the in-server suite first runs it: `SHOW CREATE TABLE`'s
`Create Table` key through oxmysql, and CTAS of a table with generated columns.
