# The mica_devices row is one of the tables a handover moves

`mica_devices` carries a `device_id` column, so `defineService` puts its
repository in `deviceKeyedRepositories`, and `handOver` in
`server/services/Devices.ts` moves that row's `citizenid` along with every other
table. So "does this phone need a handover?" cannot be answered from that row
alone unless the walk is ordered so that it can.

MICA-319 is the case. A partial handover was cached in `holderOf`, so the tables
that failed were never retried. The first fix kept the leftovers in an
in-process `pendingHandover` map. Review (Bly) found that a restart drops that
map, and that the phone row had already moved first, by declaration order. After
a restart the row read "done" over tables that never moved. The settled design:

- `mica_devices` moves **last**, and only when every other table and hook has
  moved. A row still naming the previous holder is then the durable "unfinished"
  marker that the restart path already reads.
- `pendingHandover` keeps the in-process retry narrow and backed off.
- `ensureHeld` calls are chained per phone (`settling`), so two requests cannot
  walk at once. `recordHandover` writes only when the entry it started from is
  still current.

**Trap:** an "is it already done?" check that reads state the same operation
writes. The marker can succeed while the work it marks fails. Order the marker
last, and remember that process memory is not durable.

**Tests that catch it:** `server/__tests__/deviceHandoverRetry.test.ts`. It
keeps the rows in memory, applies each transfer `UPDATE` to them, and can hold a
transfer open (`hold`) to make calls overlap. Each review fix turns its own case
red when reverted.

**The marker is one-directional.** The held-back row marks a handover _to_ its
holder as unfinished, but not one going the other way. Example: a thief's
handover moves table Y and fails table X, so the row stays with the owner; after
a restart the owner has the phone back. So the first resolve of every phone in a
process walks in full, even when the row already names the holder. That costs
one indexed `UPDATE` per phone-keyed table, once per phone per process. Any test
asserting "no UPDATE on a resolve" now has to allow those transfer statements.

Related: [[negative-check-needs-a-positive-twin]]
