# A generated column in a revive key turns the revive off silently

`uniqueAfterDelete: 'revive'` finds the caller's own `deleted` row by the values
the create names, one unique key at a time, and only for a key whose every
column the create names. A create never names a generated column. Move a revive
key onto one (Hodlr's `citizenid_unique` became `live_citizen`, a status-aware
copy, in MICA-428) and the revive matches nothing: no error, just the insert,
which the key then refuses as a duplicate.

`ColumnDef.reviveAs` names the column the copy holds whenever the row holds the
key; the revive compares that column in the generated one's place.
`uniqueKeyDecisions.test` pins `hodlr.repo.revivesUnder` to `[['citizenid']]`.
The schema harness's revive variant proves it on MariaDB, including the twin: an
erased holding is never revived.

The same move breaks every older migration scenario in `test:migrations` that
names the old key: `regressDeviceNames` undoes 0015 before renaming, and the
applied-list checks expect 0015 after 0008.

Related: [[soft-delete-under-a-unique-key]],
[[an-erase-is-not-one-statement-shape]].
