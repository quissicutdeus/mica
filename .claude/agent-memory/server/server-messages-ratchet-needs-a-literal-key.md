# serverMessages.test counts a constant key as keyless

`server/__tests__/serverMessages.test.ts` scans `server/lib` and
`server/services` for `new PlayerFacingError(` and reads the key with a regex
for `key: '<literal>'`. A key passed as a constant, such as
`{ key: GENERIC_ERROR_KEY }`, matches nothing, so the site counts as keyless and
fails the per-file ratchet (`KEYLESS_BASELINE`, which "never" rises).

Write the key literally (`key: 'server.generic'`). The scanner then also checks
that it exists in `server.en.json`, which a constant would have skipped.

A message that is truly keyless by design, such as text another resource wrote
(MICA-308's add-on refusal), cannot get a catalog key. The choices are a
baseline entry with the reason beside it, or a pass-through catalog entry
(`"{message}"`) in both languages plus `pnpm generate:locales`. That is the
lead's call, so report it rather than picking one quietly.
