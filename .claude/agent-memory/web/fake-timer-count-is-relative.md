# Assert a fake-timer count as a difference

`vi.getTimerCount()` is never zero in the add-on host suites. `recordConsent`
(and anything else that writes a persisted store) queues a debounced save on the
faked clock, so `expect(vi.getTimerCount()).toBe(0)` after `dispose()` fails for
a timer that is not yours. Read the count first, then assert `pending - 1`.

The same suites run under `@testing-library/svelte`, whose `waitFor` polls on
the faked clock too. Use `vi.useFakeTimers({ shouldAdvanceTime: true })` before
`render`, or `waitFor` never advances.

Found on the add-on startup watchdog (`ADDON_HELLO_TIMEOUT_MS`, 2026-10-14).
