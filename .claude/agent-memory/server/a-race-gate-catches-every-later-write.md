# A race test's gate catches every later write to the table

`reports.test.ts`'s "lets only one of two overlapping resolves moderate the
target" held every `UPDATE mica_reports` on a promise gate and released exactly
two. MICA-386 added a third `mica_reports` write after the claim (the takedown's
replaced status), which parked on the gate forever. The suite showed a 5-second
timeout, not a wrong answer, so it looked like a flake.

**Why:** a gate keyed on the table name rather than on the one statement in the
race counts every write that comes later as part of the race.

**How to apply:** when a handler gains a write, grep its suite for `gate.push` /
`mockImplementation` keyed on a table name. Key the gate on the statement under
test, for example the claim's ``WHERE `id` = ? AND `resolution` = ?``. A timeout
in a race test after a handler change is this trap, not flake.

## A stuck gate now outlives its test

Since the MICA-386 review, `Reports.ts` queues every decision about one reported
row (`oneDecisionAt`, process memory, keyed `table#id`). A test that never
releases a gate leaves that queue blocked for the rest of the file, so every
later test on the same target times out at 5 seconds. The first failure is the
real one. A race test can no longer expect two claims on one row to be in flight
together; release each claim as it arrives.
