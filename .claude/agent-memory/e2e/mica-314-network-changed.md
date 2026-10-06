# MICA-314: "element not found" at the first assertion after goto can be ERR_NETWORK_CHANGED

`music.spec.ts`'s `beforeEach` flaked on `cef-floor` ("YouTube link" not found
at 5s). It was not load and not the `?app=` deep link: Chromium aborted every
in-flight request for the shell's own bundle with `net::ERR_NETWORK_CHANGED`
because this desktop's network interfaces changed mid-run (Docker veth
interfaces and IPv6 address changes, from the Forgejo runner's job containers;
`ip -ts monitor link address route` shows them). `page.goto` still resolves,
because a failed subresource does not fail `load`, but the entry module never
ran, so the page stayed blank and no timeout would have helped.

- **How it was found:**
  `taskset -c 0 playwright test music.spec.ts --project=cef-floor --workers=6 --repeat-each=6`
  reproduced it once in 138; the failed run's `trace.zip` (unzip it into the
  scratchpad) has the console lines
  `Failed to load resource: net::ERR_NETWORK_CHANGED` for seven asset URLs
  within 300ms. The error-context.md has no page snapshot and says nothing. Read
  the trace's console before blaming load.
- **Not reproducible by CPU starvation alone.** 24 busy loops plus 16 workers,
  and the whole suite, both passed; one pinned core made post-load app time
  reach 7s without failing. The network change is the trigger.
- **Fix:** `web/e2e/support/networkChange.ts`, installed by the `page` fixture
  in `support/test.ts`. It re-navigates, at most three times, only when a
  request fails with that exact error, and records a `network-changed`
  annotation. A run that needed it is visible in the JSON reporter's
  annotations.
- **Cannot be provoked from a test:** `route.abort` has no network-changed code
  and the sandbox has no root. `network-change.spec.ts` drives the mechanism
  with `connectionreset` and an injected predicate, and pins the real error text
  separately.
- **A bash guard trap while chasing it:** `pkill -f 'while :'` matches the shell
  running the command and kills it (exit 144); the guard also refuses any
  command that expands a shell variable into a path next to `sed`/`node`/
  `taskset`, so spell the scratchpad path out.
