# Catch inside the async method, not at the call site

When a caller does not await an async game step (`DeviceAnimation.playIdle`,
`spawnProp`'s model load), put the `.catch` inside the method so it never
rejects, and keep `void` at the call site.

**Why:** MICA-467 first wrote `DeviceAnimation.playIdle(...).catch(...)` in
`openDevice`. `DeviceVisibility.test.ts`, `publicApi.test.ts` and
`Shell.test.ts` mock `playIdle` as a bare `vi.fn()`, which returns `undefined`,
so `.catch` threw a TypeError and 17 tests in three other suites went red. The
real method returns a promise, so nothing in the types warned about it.

**How to apply:** when you change how a caller handles a client game module's
promise, run every `client/__tests__` suite, not only your own. Prefer making
the callee total over editing other suites' mocks. `focusRelease.test.ts` counts
a `.catch(` as an async site, so moving one changes `ASYNC_SITE_COUNTS` and the
site ids in `ASYNC_FAILURES`. Also see [[has-loaded-stubs-must-answer-true]].
