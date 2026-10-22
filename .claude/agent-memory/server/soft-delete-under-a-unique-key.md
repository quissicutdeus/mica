# A soft delete under a unique key refuses the row coming back

`Repository.delete` never deletes: it sets `status = 'deleted'`. On a table
whose unique index does not include `status`, the deleted row still holds the
key, so creating the same row again is a duplicate-key error that reaches the
player as the generic failure.

Found by `test:endpoints` (MICA-304) on `mica_blocklist`: block, unblock
(generic `delete`), block again. MICA-318 fixed it by hand; MICA-321 made it
generic. Every `defineService` table with a unique index now declares
`uniqueAfterDelete`: `'revive'` (`Repository.create` re-activates the caller's
own deleted row under the key, `citizenid` plus null-safe `device_id <=> ?`,
named columns written, the rest `= DEFAULT`, `created_at` refreshed) or
`{ optOut: '<reason>' }`. A child table with a unique index may only opt out.
`uniqueKeyDecisions.test.ts` fails an undecided one.

As of MICA-321 only battery, blocklist and hodlr revived; since MICA-414 the
blocklist has no generic CRUD and opts out, so battery and hodlr are the two
(`uniqueAfterDelete: 'revive'` in `server/services/`). The rest opt out, each
for its own reason: accounts keep a handle forever, conversations' `pair_key` is
NULL off `active`, phonenumbers' `assign` reads the refusal and `claimRow`
reactivates by hand, the upsert tables (settings, lockscreen, highscores)
hard-delete or never delete, the import ledger is permanent.

**"NULL off `active`" was not the whole story for `pair_key` (MICA-342).** A 1:1
that one side has left stays `active` for the other side. The non-admin `delete`
leaves it, and a privacy delete purges the membership row while the cascade
guard keeps the thread. `findOneToOne` needs both phones live, so it stopped
matching, but the key stayed, so every new thread between the two was a
duplicate key and `server.generic`. The fix releases the key as the side leaves.
`ConversationRepository.releasePair` nulls both pair columns on a leave, and
`releasePairsOf` does the same from Privacy's `onBeforeSelfServiceDelete` hook.
Migration `0009_wedged_pairs_released` released the pairs that were already
wedged. Releasing lazily at create time cannot be made race-free, because a
thread whose participant rows are not written yet looks exactly like a broken
pair. When a row's liveness depends on another table, ask what still holds the
key once that table moves.

**Blabber's mouths wedged until MICA-330.** Generic delete is on, and
`account_mouth (account_id, mouth_of)` ignored status, so mouth, delete, mouth
again answered "You have already mouthed that". Reviving would be worse: the
feed pages by `id DESC`, so the revived mouth would sit at the old position with
the old reactions. Migration `0012_blabber_mouths_unique_while_live` took
`phone_key`'s shape: `mouth_key` is generated NULL only on `'deleted'`, and
`account_mouth_key (account_id, mouth_key)` replaced the old key. No dedupe is
needed when the old key is strictly stronger than the new one. Add the new key
before dropping the old one, so the table always has a constraint. Dropping a
unique key led by `account_id` cost `mouth_of`'s foreign key nothing, because
InnoDB had already given it its own `fk_mica_blabber_mouth_of` index.

**A status-keyed slot must stay held by every status something can reverse.**
The first draft freed the slot off `'active'`, so a moderated mouth freed it.
The author mouthed again, the admin reopened the report, and `restoreTarget` hit
ER 1062 and showed the generic error. Review caught it; every suite was green.
`moderated` holds now, and the move still refused (moderating a deleted mouth
whose author has mouthed again) answers `server.reports.targetConflict` from
`moderation.ts`. `test:migrations`' `runMouthKeyMigration` checks what the key
refuses in each status on a real MariaDB. Before you free a slot for a status,
list the transitions out of it: `Reports.ts` restores to `'active'` blindly,
even a row that was `'deleted'` before the takedown.

No unit suite can see a duplicate key: they mock `Database`. The stand-ins in
`uniqueAfterDelete.test.ts` and `blocklist.test.ts` enforce the key and fail on
an unknown statement; copy that shape. The revive SQL was checked on MariaDB 11
by hand (`<=>` with a NULL bind, `SET col = DEFAULT`, a racing second `UPDATE`
matching 0 rows). `test:endpoints` drove it through the blocklist's handler
until MICA-414 removed that handler. `test:schema`'s `runReviveVariant` now
proves it on a real MariaDB, on qb and ESX, through the declared Hodlr and
Battery repositories (same id back, one row, unnamed column to DEFAULT,
`created_at` refreshed, a foreign owner still refused); the mocked
`uniqueAfterDelete.test.ts` stays for the SQL's shape.
