# A soft delete under a unique key refuses the row coming back

`Repository.delete` never deletes: it sets `status = 'deleted'`. On a table
whose unique index does not include `status`, the deleted row still holds the
key, so creating the same row again is a duplicate-key error that reaches the
player as the generic failure.

Found by `test:endpoints` (MICA-304) on `mica_blocklist`: block a number,
unblock it (generic `delete`), block it again, and the insert fails on
`phone_number_unique (phone_id, number)`. `isBlocked` and `blockedBy` already
filter `status = 'active'`, so the stale row does nothing except refuse the
re-block. Latent on 2026-10-06 only because no app route reaches `blocklist`
yet; any UI that adds one hits it.

No unit suite can see it: they mock `Database`, so the second insert succeeds.
`test:schema` has no handlers. What catches it is a create, a generic delete and
the same create again against MariaDB, through the handler, which is what
`test:endpoints` is for. Before relying on a unique index to stop a double-tap,
check whether the table's delete is soft and the index ignores `status`, and
decide whether a re-create should revive the row
(`ON DUPLICATE KEY UPDATE status = 'active'`, as `SettingsRepository.put` does)
or be refused on purpose.
