# Removing a name from index.ts is not a contract bump

`BASELINE_EXPORTS['@mica/sdk']` in `sdk/publicSurface.test.ts` is `index.ts`,
the shell's barrel, and the package publishes it under no subpath
(`UNPUBLISHED_BY_DESIGN`; `package.json`'s `.` is `addon.ts`). So nothing
outside this tree compiled against a name that is on `index.ts` alone. Taking
one off still fails
`breaks no add-on that was written against the pinned contract`, but the right
fix is to edit the frozen list with a comment saying why, not to bump
`SDK_CONTRACT_VERSION`.

**Why:** found while taking `setTrustedRemoteAppHosts` and `setRemoteCatalogUrl`
off `index.ts` (2026-10-14). Neither was on `addon.ts`, and any `core: true` app
could rewrite the shell's add-on trust boundary through them. A bump would have
told add-on authors about a break that cannot reach them.

**How to apply:** first check whether the name is on `addon.ts`. If it is,
removing it is a real break: bump the version. If it is only on `index.ts`, edit
the baseline with a comment beside the removed lines. If the name must never
come back, add it to `NEVER_EXPORTED`. Otherwise
`publishes nothing nobody decided to publish` fails when someone re-adds it, and
that test's own message tells them to add it to the baseline.
