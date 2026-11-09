# A whole-database diff flakes on second-resolution timestamps

MICA-464's access matrix (`scripts/lib/access-matrix.js`) reads every `mica_*`
table before and after an attacker's call and fails on any change. One run in
four failed `messages:send.attachments[0].photo_id`: the attacker's text landed
in the attacker's own thread, and that thread's `updated_at` moved only when the
second turned over between the two snapshots. `last_read = CURRENT_TIMESTAMP` in
`ConversationRepository.markRead` does the same to a control's evidence.

So an "anything changed?" oracle must let the caller's own rows change — owned
by the caller before and after, naming the victim's id in no column — and must
not count a category by "something changed" either, or the count follows the
clock. The matrix counts a strip by an _added_ row, never a changed one.

Run a new diff-based check three times before trusting it: one green run proves
nothing about a boundary that falls one call in four.

Related: [[negative-check-needs-a-positive-twin]].

It bit twice in one ticket. Allowing a pinned column to move (a DM's `read_at`,
set by its recipient) failed two runs in three until `updated_at` was allowed
beside it: `ON UPDATE CURRENT_TIMESTAMP` moves it only across a second boundary.
