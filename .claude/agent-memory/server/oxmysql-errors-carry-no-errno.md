# oxmysql errors carry no errno, and embed the query

A failed `Database.*` call rejects with whatever oxmysql's `*_async` export
built: `new Error(output)`, where `output` is
`"<resource> was unable to execute a query!"`, `Query: <the whole SQL>`, the
parameters, and only then mysql2's message on the last line (`src/index.ts` and
`src/logger/index.ts` in the oxmysql source). There is no `errno` and no `code`
on it.

So a branch on a MySQL error number (1050 table exists, 1142 command denied)
that reads `error.errno` passes every suite that throws a mysql2-shaped error,
passes `test:schema` (mysql2 in-process, errno present), and never fires in a
real server. Matching the whole message is the other trap: the query text is in
it, so a statement that contains the words matches itself.

`server/lib/sqlErrors.ts` has `reasonOf` (the driver's last line, '' when that
line is the parameters) and `schemaBootstrap.ts` (MICA-306) has `driverErrno`:
errno or code when present, otherwise read off that last line. The test that
would have caught it throws the oxmysql shape, not the mysql2 one —
`schemaBootstrap.test.ts`'s `oxmysqlError`. Reuse those before classifying a
driver error anywhere else; `ConversationRepository`'s `/duplicate/i` match is
the older precedent and reads the whole message.

For ER 1062 use `isDuplicateKey` in `server/lib/sqlErrors.ts` (MICA-335), which
reads errno, then the last line only. It replaced `phoneNumbers.ts`'
`isDuplicateEntry`, which matched the whole text.

## Logging one leaks the parameters

The same shape makes `console.error('…', error)` a leak: the parameters line is
a message body, a mail subject, a notification preview. MICA-329 logs a failed
notification insert through `notificationFailureReason` in
`services/Notifications.ts`, now `reasonOf` with a constant for ''. The test
that catches it throws the oxmysql shape with the body in its parameters and
asserts the body is absent from every logged line — `notificationBatch.test.ts`.
A mysql2-shaped error carries no parameters, so a suite that throws one cannot
see this.

## It is not this realm's `Error` either

oxmysql builds `new Error(output)` in its own resource, so in mica
`error instanceof Error` is **false** on every real rejection. A check written
`error instanceof Error ? error.message : ''` reads every in-game duplicate as
`''` and rethrows it: `accounts:react` answered a second ❤️ with the generic
error until the in-server suite caught it (run 39242728050). A suite rejecting
with this realm's `new Error('Duplicate entry')` passes that check.
`isDuplicateKey` reads `String(error)`, which survives. The test that catches it
rejects with `oxmysqlRejection` (`server/__tests__/oxmysqlRejection.ts`), built
by `node:vm`'s `runInNewContext`. All eight `/duplicate/i` sites in `server/`
moved to `isDuplicateKey` in the same change; grep for `instanceof Error` near a
driver error before trusting a new one. `vi.clearAllMocks` keeps `…Once` queues,
so a race test that fails before its lookup leaks `[winner]` into the next test
— answer the lookup from state instead.

## A log-only catch loses the reason the same way

A catch that only logs, and reads `error instanceof Error ? error.message : ''`,
fails no player and no suite: it logs an empty reason for every real driver
failure, so the operator sees that something failed but not what.
`Conversations.ts`' `frameworkNumberOf` (esx leaving number, MICA-350) did this
until the duck-typed `'message' in error` read replaced it; the case in
`conversations.test.ts` rejects `resolveMany` with `oxmysqlRejection` and
asserts the driver's line is logged and the query and parameters are not.

Every such read in `server/` (about twenty) moved to `reasonOf` on 2026-10-19,
and `errorReasons.test.ts` fails an `x instanceof Error` whose function also
reads `x.message`. It cannot tell a plain `{ message }` from a foreign `Error`,
so `notificationBatch.test.ts` stopped pinning the plain object to the constant.
An empty driver line (ECONNREFUSED's `AggregateError`) gives '', so a log that
would end "failed: " passes `reasonOf(error, NO_REASON)`; a review caught four.
