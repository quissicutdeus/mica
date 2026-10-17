# apply runs migrations before it creates a missing table

Since MICA-388, `micaschema apply` creates a missing table (audit ledger, app
table, child table) as `CREATE TABLE IF NOT EXISTS` from the declaration, in
`bootstrapTables` order, before the column and index pass. Until then a missing
table planned **nothing**: `micaschema` said "import mica.sql", apply ran zero
statements and printed "schema is already up to date".

Traps that hid it:

- A harness check that flattened `p.additive` and `p.drift`
  (`runPlayersKeysMigration`'s "planner finds nothing to add") was blind to a
  missing table. Flatten `p.create` too.
- Versioned migrations still run **first**, so a migration that ALTERs a table
  it never checked for stops apply before the creates on an empty ledger (a
  half-created first start). 0001, 0003 and 0002 all did until MICA-389. 0002's
  table is `mica_phones`, which the final shape never has, so its guard skips
  only when `mica_contacts` is missing too; contacts without `device_id` must
  still fail loudly (an old re-import).
- A new migration must ask `information_schema.TABLES` first, or the
  half-created sweep in `runApplyFinishesHalfCreated` fails at the cut before
  its table. That sweep stops the bootstrap before every table on both shapes
  and is why `finishByHand` can say "run 'micaschema apply'" alone.

Mapping which cut points fail took one throwaway copy of the harness looping
over `createStatements(...).slice(0, cut)`; the fixture now does exactly that.
