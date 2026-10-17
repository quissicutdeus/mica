# The encrypted-column guard cannot see an interpolated table name

`encryptedColumns.test.ts` scans `server/` for SQL that names an encrypted
column and holds each statement to the function it sits in, which must call
`openRows`/`sealRow`/…. It reads the statement as the source spells it, so a
table written as `` `${TABLE}` `` is **not seen at all**: the read passes the
guard whether or not it opens the body.

MICA-254 hit it: Dark Chat's page read was built in a `pageSql()` helper over
`${TABLE}`. The suite was green, and only the ALLOWLIST pin (a new encrypted
column) failed. Had the read forgotten `openRows`, nothing would have said so.

**Why:** the guard is a source scan, not data flow; its own docblock says an
expression table name "reads the registry instead", but nothing reads a
service's hand-written SQL that way.

**How to apply:** write the table literally in any statement that selects an
encrypted column, inside the handler that opens it, and list the file under the
table in that test's `ALLOWLIST`. Prove it by deleting the `openRows` call: the
guard's "neither opens nor seals" case should go red.
