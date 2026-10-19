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
