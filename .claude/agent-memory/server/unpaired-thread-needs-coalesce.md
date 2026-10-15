# An unpaired 1:1 holds NULL pair columns; NOT LIKE skips it

Since MICA-342 a 1:1 a side has left keeps `participant_a`/`participant_b` NULL.
`releasePair` and `releasePairsOf` exclude line threads with
`c.participant_a NOT LIKE 'ext:%'`. That is right for them, because they only
ever touch a thread that is still paired. A query **about** an unpaired thread
(MICA-349's `nobodyElseIn`) has to `COALESCE(c.participant_a, '')` first.
`NULL NOT LIKE ?` is NULL, so the row it exists for is silently dropped, and no
unit suite executes the SQL to notice. `test:endpoints`' `leftThread` flow is
the proof against MariaDB.

Two more traps from the same change:

- `mica_messages_participants.device_id` is nullable on legacy rows, so "a
  member on another phone" is `NOT (p.device_id <=> ?)`, not `<>`.
- Read a yes/no off a **named** column (`SELECT 1 AS nobody_else`), never off "a
  row came back". `conversationPrivacy.test.ts` answers every non-number
  `single` with `{ 1: 1 }`, and a row-presence check would refuse every send in
  it.

A new `conversationRepo` method called from `messages:send` also breaks
`messageDelivery.test.ts`. That suite mocks `services/Conversations` with only
`findParticipants`, the throw is answered as `server.generic`, and the failure
reads as an assertion on the reply rather than "is not a function". Grep the log
for `TypeError` first.
