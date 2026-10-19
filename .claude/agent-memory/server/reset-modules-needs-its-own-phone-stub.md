# A fresh module graph needs its own phone stub

`vi.resetModules()` plus dynamic imports is how a suite loads a module whose
start-time read (a convar read once at import, like `mica_integration` in
`server/lib/integrationDoor.ts`, MICA-397) must differ between cases. The trap:
`setup.ts`'s `beforeEach(installTestPhone)` installs the device resolvers on the
**original** `lib/deviceIdentity` instance. Services imported after the reset
bind a fresh instance with no resolvers, so any action flagged `requirePhoneFor`
throws "not installed" and answers the generic error rather than running.

Fix: import `./phoneStub` dynamically after the reset, in the same graph, and
call that copy's `installTestPhone`/`refusePhone` in the suite's own
`beforeEach`. The same applies to `__resetRateLimits` and every other
module-state seam: take it from the fresh graph, never from a static import.

The test that showed it: `server/__tests__/integrationDoor.test.ts`, whose
`load()` helper returns the fresh `phone`, `rateLimit`, `casino` and `appEvents`
modules together.

Related: `convars.test.ts` scans only `client/`, `server/` and `shared/`, so a
convar the `integration/` harness already read (`mica_integration`) still needs
a README row the first time server code reads it.
