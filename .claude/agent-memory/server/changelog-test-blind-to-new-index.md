# changelog.test now wants an index by its own name

Until MICA-309 (2026-10-06), `server/__tests__/changelog.test.ts` held an added
index to its table name appearing anywhere in `CHANGELOG.md`, so a new key on
almost any table passed with no entry. MICA-307's `participant_b_status` did.

Since MICA-309, a column or index on a table in the frozen `BASELINE` is
announced only by **one blank-line-separated entry** that backticks both the
table and the column or key's own name (`table.name` in one span counts), inside
`## Unreleased` or a section dated on or after 2026-08-29. Writing "gains a
unique index" without the derived name (`pair_key_unique`) no longer counts —
that exact gap was the one entry MICA-309 found missing.

Still blind: a second column or key on a table that is itself new since the
baseline is accepted on the table's name alone. When a declaration adds one
there, report that an entry is needed whatever the test says. The lead owns
`CHANGELOG.md`.
