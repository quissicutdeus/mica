# A row kept but hidden is still writable by its id

Before MICA-428 a purged row was gone, so no player action could reach it. Kept
as `erased` or `expired`, it is still in the table under its owner's citizenid,
and a privacy-deleted player still exists:

- the generic `update` let them rewrite evidence by id;
- the generic `delete` moved an erased row to `deleted`, and `restore` (which
  reads `deleted` only) then brought it back live.

`Repository.updateOwned` guarded only `moderated`. It now refuses `moderated`,
`erased` and `expired` alike. A named write in a service that says
`status = 'active'` in its `WHERE` was already safe.

Two more readers that only excluded `deleted` needed the same change: Casino's
history and cash-out reads would have shown erased rounds back to their owner,
and Spark's `liveProfileOf` would have found an erased profile.

The check before adding a status: grep `<> 'deleted'`, `!= 'moderated'` and
`status <> '` across `server/`. Each one asks "not hidden" with a list that no
longer covers every way a row is hidden.

Related: [[soft-delete-under-a-unique-key]],
[[negative-check-needs-a-positive-twin]].
