# A soft delete under a unique key refuses the row coming back

`Repository.delete` never deletes: it sets `status = 'deleted'`. On a table
whose unique index does not include `status`, the deleted row still holds the
key, so creating the same row again is a duplicate-key error that reaches the
player as the generic failure.

Found by `test:endpoints` (MICA-304) on `mica_blocklist`: block a number,
unblock it (generic `delete`), block it again, and the insert fails on
`phone_number_unique (phone_id, number)`. Fixed in MICA-318 by a
`BlocklistRepository.create` that first re-activates the caller's own deleted
row for the pair (both statements name `citizenid` and `phone_id`), then falls
back to the insert. `test:endpoints` now asserts block, unblock, block again.

No unit suite can see it: they mock `Database`, so the second insert succeeds.
`blocklist.test.ts` now carries a small in-memory stand-in that enforces the
key; copy that shape when a unit test is about a unique key. `test:schema` has
no handlers. What catches it for real is a create, a generic delete and the same
create again against MariaDB, through the handler — `test:endpoints`.

Where the trap can bite: a table with a generic `delete` (or any write of
`'deleted'`) **and** a unique key that ignores `status` **and** a create path
that does not revive. As of MICA-318 the others are not reachable: Accounts has
no delete and keeps a handle taken forever on purpose; PhoneNumbers revives in
`claimRow`; Battery and Hodlr have no delete (but their `findAll`-then-`create`
would collide if one were added, since `findAll` filters `active`); Settings
upserts and hard-deletes; the import ledger is never deleted. The player-data
purge (`purgeOwnedRows`) is a hard `DELETE`, so it frees keys rather than
wedging them. Before adding a delete to any of those, decide whether a re-create
revives or is refused on purpose.
