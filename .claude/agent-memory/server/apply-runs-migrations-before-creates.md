# apply runs migrations before it creates a missing table

Since MICA-388, `micaschema apply` creates a missing table (audit ledger, app
table, child table) as `CREATE TABLE IF NOT EXISTS` from the declaration, in
`bootstrapTables` order, before the column and index pass. Until then a missing
table planned **nothing**: `micaschema` said "import mica.sql", apply ran zero
statements and printed "schema is already up to date".

Two traps that hid it:

- A harness check that flattened `p.additive` and `p.drift`
  (`runPlayersKeysMigration`'s "planner finds nothing to add") was blind to a
  missing table. Flatten `p.create` too.
- Versioned migrations still run **first**. 0001 (`mica_phone_numbers`) and 0003
  (`mica_battery`) ALTER their table without asking `information_schema.TABLES`
  whether it exists, so on a database lacking one of those tables with an empty
  ledger (a half-created first start) apply stops at the migration and creates
  nothing. That is why `schemaBootstrap.ts`'s `finishByHand` still says import
  first.

Test that catches it: `runApplyCreatesMissingTables` in
`scripts/test-migrations.js`.
