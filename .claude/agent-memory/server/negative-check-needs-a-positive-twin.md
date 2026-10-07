# A "does not see it" check passes on a wrong filter

Writing `test:endpoints` (MICA-304), "2 does not see 1's setting" passed while
the filter read `row.key`/`row.value` — `mica_settings` rows are
`setting_key`/`setting_value`, so the filter matched nothing for anyone. The
reconnect check further down failed for the same reason and exposed it; had it
not existed, an ownership check would have been green and meaningless.

So: every negative assertion about rows (not visible, not pushed, not written)
gets a positive twin built from the same filter first — "1 reads it back", then
"2 does not see it". The same holds for a `since(mark, filter)` over captured
`emitNet`s: assert the filter finds the push you expect before asserting it
finds none of the one you forbid. Read the row shape from the repository's
`SELECT`, not from the action's input names.
