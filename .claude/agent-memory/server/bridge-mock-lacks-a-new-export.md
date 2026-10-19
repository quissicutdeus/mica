# A new FrameworkBridge export read at import breaks other suites' mocks

`reachability.test.ts` (and others) `vi.mock('../lib/FrameworkBridge', …)` with
only the `FrameworkBridge` class. A module that reads a **new** named export
from the bridge at module scope — `const FIRST_SOURCE = SYNTHETIC_SOURCE_MAX` in
`lib/integrationDoor.ts`, MICA-397 — fails that suite's collection with
`No "X" export is defined on the mock`, while its own suite and `tsc` are green.

**Why:** vitest's mock proxy throws on access to an export the factory did not
return; a read at import is an access, a read inside a function that never runs
is not.

**How to apply:** read a new bridge export only inside a function, or write the
value out locally and pin it equal in the bridge's own test. Run
`reachability.test.ts` whenever a lib module imports something new from the
bridge.

**A new static method has the same trap at call time.** About 80 suites mock the
bridge, and none carries a method added later. `isAdmin` runs in many of them,
so calling `FrameworkBridge.isSyntheticAdmin` on every check would throw
`not a function` all over the suite. MICA-386's door admin calls it only for
`source <= -1_000_000`, with the bound written out in `Admin.ts`, and no mocked
suite passes a source that low.
