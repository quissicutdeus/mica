# A DM policy is registered by the app's file, so a suite may already have it

Since MICA-390 `dms` (`server/services/DirectMessages.ts`) refuses an app with
no policy, and Blabber's policy is registered by `Blabber.ts` at import time.
`registerDmPolicy` throws on a second registration for the same app.

The trap: `encryptedColumns.test.ts` never imports `Blabber.ts` by name, yet
something it imports does, so a test-local `registerDmPolicy('blabber', …)`
failed collection with "already has a DM policy". A suite that needs a policy
for an app no service registers uses its own id (`testapp`) and
`unregisterDmPolicyForTests` in `beforeEach`; one that needs Blabber's imports
`../services/Blabber` and uses the real one.

A dynamic `import('../services/DirectMessages')` inside a case also starts the
notification sweep, whose `DELETE FROM mica_notifications` lands in
`dbMock.query` — clear the mock after the import before asserting "no read".
