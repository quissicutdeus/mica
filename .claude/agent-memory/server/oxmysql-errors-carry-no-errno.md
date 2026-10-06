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

`server/lib/schemaBootstrap.ts` (MICA-306) has `driverMessage` and
`driverErrno`: errno or code when present, otherwise the driver's last line
only. The test that would have caught it throws the oxmysql shape, not the
mysql2 one — `schemaBootstrap.test.ts`'s `oxmysqlError`. Reuse those before
classifying a driver error anywhere else; `ConversationRepository`'s
`/duplicate/i` match is the older precedent and reads the whole message.
