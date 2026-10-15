# `__resetAppEvents` wipes module-scope subscribers

`__resetAppEvents()` in `shell/state/appEvents.ts` clears **every** handler, not
only buffers. A module that subscribes at import time —
`services/notifications.ts`' `('*', '*')` observer,
`shell/state/liveLocation.ts` — is registered once, when the suite first imports
it, and never again. Reset in a `beforeEach`/`afterEach` and every later test in
that file silently loses the subscriber it is testing.

**How to apply:** in a suite that exercises an import-time subscriber, drain
with `clearAppEvents('<app>')` per app the test pushed to, never
`__resetAppEvents`. Reset is right only in `appEvents.test.ts`, which imports no
subscriber.

Related: the shade refresh is coalesced on a 250 ms timer (MICA-338), so a suite
asserting on it needs `vi.useFakeTimers()` and `vi.runAllTimersAsync()` in an
`afterEach`, or a scheduled refresh lands in the next test.
