# A dedupe before ADD UNIQUE KEY must compare as the key does

MICA-335 added `device_phone_unique` to `mica_contacts`. Two traps, both of
which every mocked suite passes.

**`'revive'` is refused on a table with a NOT NULL, undefaulted column** outside
every unique key (`firstname` here), and opting out of it wedges delete then
re-add. The way out is `pair_key`'s: a generated column that is `NULL` off
`'active'` (`phone_key`), keyed beside `device_id`. A deleted row holds no key,
so the decision is an opt-out with a real reason, and no revive is needed.

**The settling query must join on what the key compares.** Joining on the raw
column, or on bytes, leaves rows the key calls equal: `555-TAXI` and `555-taxi`
under `utf8mb4_unicode_ci`. The `ADD UNIQUE KEY` then aborts on ER 1062, the
MICA-153 failure. Add the generated column first, join on it, then add the key.
`test:migrations`' `runContactKeyMigration` fails with `BINARY` in the join; I
broke it to check.

Soft-delete the extra rows with `updated_at` pinned rather than delete them; the
harness checks no row was removed.

Related: [[soft-delete-under-a-unique-key]],
[[new-column-trips-the-privacy-pin]]
