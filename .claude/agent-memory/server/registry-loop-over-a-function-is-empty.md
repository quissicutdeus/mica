# A loop over a registry function asserts nothing

`moderation.ts` exports `REPORTABLE` as a **function** returning the registry,
so the map can be filled at import time. `reports.test.ts` had
`for (const [table, meta] of Object.entries(REPORTABLE))`, which is
`Object.entries` of the function itself: `[]`. The test "every reportable table
declares how to preview it" ran zero iterations and was green from the day
`REPORTABLE` stopped being an object. MICA-339 found it while adding a per-table
visibility rule that needed the same loop.

So: a test that walks every entry of a registry first asserts the entry count,
`expect(entries.length).toBeGreaterThan(0)` or a floor that names how many there
are, and calls the accessor (`REPORTABLE()`). `tsc` never sees it, because
server tests are not typechecked (see
[type-tests-belong-in-integration](type-tests-belong-in-integration.md)).

Also, a registry filled by import (`registerReportable`, `registerReactable`)
holds only what the test file imported. `reports.test.ts` did not import
`Marketplace`, so `mica_marketplace` was missing from every loop over it. Import
every service that declares into the registry, and keep the count floor so a
missing import shows.

Related:
[negative-check-needs-a-positive-twin](negative-check-needs-a-positive-twin.md).
