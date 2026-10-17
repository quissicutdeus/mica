# A unique key on a permanent parent's id makes a soft delete permanent

MICA-255's brief put `UNIQUE (account_id)` on `mica_spark`. Nothing deletes an
account, and a citizen holds one Spark account for good, so that key would have
held the deleted profile's slot forever: `remove`, then `save` again, is ER 1062
and the generic toast.

`uniqueAfterDelete: 'revive'` cannot rescue it. `defineService` refuses a revive
whose table has a NOT NULL column with no default that is not in **every**
unique key, and `account_id` was not in the `live_citizen` key. Reviving by hand
works, but keeps the old id, so an open report on the deleted profile would
preview the new bio.

The fix was to drop the unique on `account_id` and let the status-aware
generated key (`live_citizen`, NULL on `deleted`) carry the rule. A re-created
profile is then a new row, and the old row keeps the old words for any report.

**How to apply:** for each unique key, ask whether its parent can ever go away.
If it cannot, a soft-deleted child holds the key forever. The shape-matched unit
world will not show this. Replay `delete then create` on a throwaway MariaDB
([[replay-captured-sql-on-mariadb]]).

A second trap from the same suite: a substring shape matcher for the photo read
(`FROM mica_spark_photos p JOIN mica_media m`) also matched the deck, whose
`EXISTS` subquery has the same text. The deck got the photo branch's answer.
Anchor a branch on the statement's start (`SELECT p.\`id\``), not on a fragment
that a subquery can repeat.
