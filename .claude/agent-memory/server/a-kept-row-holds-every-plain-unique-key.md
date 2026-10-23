# A kept row holds every unique key over a plain column

Before MICA-428 a purge deleted the row, which freed every unique key it held.
Kept as `erased`, it holds each key that is not status-aware, for good.

The review found the keys one at a time:

- First pass: Blabber, Spark, Hodlr, highscores, settings and blocklist.
- Second pass: `conversation_device_unique` on `mica_messages_participants`.

The handover leaves an erased membership naming the dead character, so their row
held the phone's seat in that thread. The next holder reopening a line thread
hit `Duplicate entry` on the insert. `ensureLineParticipant` reopens only `left`
rows, so nothing else frees the seat.

The fix moves the key onto `live_device`, written as
`CASE WHEN status <> 'erased' THEN device_id END`. Use the same form for the
next such key. Do not null `moderated` as well: a moderated membership must keep
its seat, or the line rejoin inserts past the takedown.

The check: list every `UNIQUE KEY` in `mica.sql` and ask of each one whether a
kept row of a gone owner can stop someone else from taking the same values. The
collision needs the parent row to survive the purge. A thread survives when
another character created it, so the scenario has to build that case.
`runLineMembership` in `test-schema.js` does, and fails on the old key.

Related: [[soft-delete-under-a-unique-key]],
[[a-generated-key-column-silences-revive]],
[[an-erase-is-not-one-statement-shape]].
