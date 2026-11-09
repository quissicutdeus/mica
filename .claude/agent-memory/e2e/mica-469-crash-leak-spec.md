# MICA-469: a crash-leak spec, and the add-on error rule in support/test.ts

`web/e2e/addon-crash-leak.spec.ts` counts `Documents` after a forced GC for
add-on frames that end in an uncaught error or an unhandled rejection, against a
no-crash baseline run the same way in its own browser context. Same rule as
[[mica-451-never-enter-an-addon-frame]]: outer page only; boot is proved by
`booted:<id>` console lines the bundle prints (frame console reaches the page's
`console` event without Playwright evaluating in the frame).

- Pre-fix, cef-floor: baseline 5, after 8 (+1 per crashed frame), 10/10 red;
  modern chromium never leaks (5/5), so only the cef-floor project can fail.
- The shell removes a crashed frame on an error, but pre-fix NOT on a rejection
  (not forwarded). So do not assert "removed on crash"; let pool eviction remove
  it and assert only documents.
- Under parallel workers cef-floor read baseline+1/+2 even with the fix. Cause:
  the trace DOM snapshotter (`trace: 'retain-on-failure'`) injects into every
  frame, races a crashed frame's removal, and 103's inspector keeps the
  exception. Fix: in both document-count specs, set the trace option to
  `{ mode: 'retain-on-failure', snapshots: false, screenshots: true }`. Poll the
  count to a limit or until it holds still for several reads, never read it
  once.
- The fix makes the frame cancel its errors, so Playwright's `pageerror` never
  fires for them. `support/test.ts` therefore also fails a test on a console
  `error` line that begins with the word Uncaught (or Uncaught in promise); a
  spec that crashes an add-on on purpose sets `allowNuiFailures: true`.
