# A read that opens a sealed column must select `citizenid`

A sealed value's authenticated data binds the row's `citizenid` plus its
`encryptionScope` columns (`contextColumns` in `server/lib/contentCipher.ts`). A
hand-written SELECT that opens the column through `openRows` has to name all of
them, even when the reply must not carry `citizenid` — strip it after the open,
not in the SQL.

MICA-339 (740b5e99) dropped `citizenid` from the DM thread and inbox SELECTs to
stop leaking the sender's character. Every sealed DM read then threw
`the row has no 'citizenid'` on a keyed server for eleven days, until in-server
run 39242728050 caught it.

**Why the suites missed it:** `openWith` skips a value that is not sealed, so a
stub row with a plaintext body never reaches `contentContext`. The one round
trip with a real sealed body (`encryptedColumns.test.ts`) answered the whole
stored row, whatever the SELECT named. And `directMessages.test.ts` asserted the
SQL did _not_ contain `citizenid`.

**How to apply:** a round trip over a sealed column answers with
`selectedFrom(sql, row)` (in `encryptedColumns.test.ts`), which cuts the row to
the columns the SELECT lists. A test asserting a column is absent from SQL
should check it is not a cipher context column first. Related:
[[negative-check-needs-a-positive-twin]].
