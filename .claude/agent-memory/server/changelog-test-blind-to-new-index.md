# changelog.test cannot see a new index on a known table

`server/__tests__/changelog.test.ts` holds an added **index** to its table name
alone (`unannouncedSchemaChanges`, around line 483). Any table already named in
a backtick span anywhere in `CHANGELOG.md` satisfies it. So a new key on
`mica_messages_conversations`, `mica_messages` or most other tables passes green
with no entry written.

A green run is therefore not evidence that the CHANGELOG is right. When a
declaration gains an index, report to the lead that an "Action required" entry
naming the table and `micaschema apply` is needed, whatever the test says. The
lead owns `CHANGELOG.md`.

Found on MICA-307 (2026-10-05), adding `participant_b_status`. The lead was told
the gate fails open. Fixing it is a test change, not a server-lane one.
