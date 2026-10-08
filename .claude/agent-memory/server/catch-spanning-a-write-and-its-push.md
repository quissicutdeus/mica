# A catch spanning a write and its push lies about the write

One `try` around an insert **and** the notify that follows it answers "failed"
for a row that exists, whenever the notify throws. For an export like
`SendSystemEmail` that answer is `null`, which a calling script reads as "not
delivered" — and one that retries puts a duplicate in the inbox (MICA-333).
Every suite passed, because nothing in them made the notify step throw.

Shape to keep: the `try` ends at the write; each notify step after it gets its
own logging catch, so a failed live push cannot cost the stored notification
either; the function answers the row once it exists. `mailSystemEmail.test.ts`
is the test that catches it: throw from `emitNet` and from the bridge lookup
`appEvents` makes, and assert the mail comes back.

Logging the outer catch's error as-is is a second leak: oxmysql's message
carries the parameters — see [[oxmysql-errors-carry-no-errno]].
