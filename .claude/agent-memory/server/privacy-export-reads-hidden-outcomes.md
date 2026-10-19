# The privacy export reads every column of every owned table, secrets included

A self-service export (`buildExport` in `services/Privacy.ts`) selects every
column of every table carrying the player's `citizenid`. `ColumnDef.private` has
no effect there: it trims only the generic list read. Casino (MICA-82) stores a
live Crash round's hidden crash point on the player's own row. Without a guard,
a player could export mid-round, read the point, and cash out one tick before
it.

The fix goes in the service's own file. It narrows the export by row and needs
no edit to core's `WITHHELD` map:

```ts
registerExportFilter(TABLE, () => ({
  sql: "`status` <> 'active'",
  params: []
}));
```

**Why:** "it is the owner's own row" reads as safe, but the export is a second
read path, and nothing in the suites flags a secret leaking through it. **How to
apply:** whenever a column holds something the owner must not see yet (an
outcome, a pending draw, a sealed answer), register an export filter or withhold
the column. Pin it in a test with `exportFilterFor(table)`.
