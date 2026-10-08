# A soft delete under a unique key refuses the row coming back

`Repository.delete` never deletes: it sets `status = 'deleted'`. On a table
whose unique index does not include `status`, the deleted row still holds the
key, so creating the same row again is a duplicate-key error that reaches the
player as the generic failure.

Found by `test:endpoints` (MICA-304) on `mica_blocklist`: block, unblock
(generic `delete`), block again. MICA-318 fixed it by hand; MICA-321 made it
generic. Every `defineService` table with a unique index now declares
`uniqueAfterDelete`: `'revive'` (`Repository.create` re-activates the caller's
own deleted row under the key, `citizenid` plus null-safe `phone_id <=> ?`,
named columns written, the rest `= DEFAULT`, `created_at` refreshed) or
`{ optOut: '<reason>' }`. A child table with a unique index may only opt out.
`uniqueKeyDecisions.test.ts` fails an undecided one.

As of MICA-321 only battery, blocklist and hodlr revive. The rest opt out, each
for its own reason: accounts keep a handle forever, conversations' `pair_key` is
NULL off `active`, phonenumbers' `assign` reads the refusal and `claimRow`
reactivates by hand, the upsert tables (settings, lockscreen, highscores)
hard-delete or never delete, the import ledger is permanent.

**Blabber's mouths still wedge, on purpose for now.** Generic delete is on, and
`account_mouth (account_id, mouth_of)` ignores status, so mouth, delete, mouth
again answers "You have already mouthed that". Reviving would be worse: the feed
pages by `id DESC`, so the revived mouth would sit at the old position with the
old reactions. A real fix needs a schema decision (status in the key, or a
`mouth_of` that is NULL off `active`, like `pair_key`).

No unit suite can see a duplicate key: they mock `Database`. The stand-ins in
`uniqueAfterDelete.test.ts` and `blocklist.test.ts` enforce the key and fail on
an unknown statement; copy that shape. The revive SQL was checked on MariaDB 11
by hand (`<=>` with a NULL bind, `SET col = DEFAULT`, a racing second `UPDATE`
matching 0 rows). `test:endpoints`' blocklist re-block is the in-harness proof.
