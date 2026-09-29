# TS 7 incremental misses a global .d.ts change

`pnpm typecheck:client` is incremental (`client/tsconfig.json` writes
`node_modules/.tmp/client.tsbuildinfo`), and under TS 7.0.2 a change to an
ambient `declare const` file does not invalidate the cached diagnostics of the
files that use it. Both directions are wrong: adding the declaration stays red,
and removing one stays **green**.

**Why:** on MICA-237 (2026-09-29) `client/buildDefines.d.ts` was added for the
`__MICA_*__` defines `sdk/version.ts` reads. `--listFilesOnly` showed it in the
program, yet two warm runs still printed the six TS2552 errors; a cold run
passed. Deleting one declaration then gave a warm rc 0 while
`tsc --incremental false` failed with two errors.

**How to apply:** after adding, removing or editing a global `.d.ts`, delete
`node_modules/.tmp/client.tsbuildinfo`, or add `--incremental false` to the
`tsc` call, before trusting the result. A fresh CI checkout has no cache, so CI
is right and a warm local run can disagree with it.
