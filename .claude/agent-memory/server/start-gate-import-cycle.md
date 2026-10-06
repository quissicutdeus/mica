# A start-up gate must not import schemaSql

`defineService.ts` imports `Repository.ts`, whose import chain reaches
`contentCipher.ts`. Any module on that chain that imports `schemaSql.ts`
(directly, or through something that does) closes a cycle back to
`defineService.ts`, and `SchemaRepository extends Repository` then evaluates
before `Repository` exists: "Class extends value undefined is not a
constructor". `tsc` is green; four server suites fail to collect, and the
summary count drops by about 140 tests instead of showing a failure per test.

Found on MICA-306, when `contentCipher.ts`'s start hook imported the first-start
schema check. The fix is the slot pattern `ownerWidth.ts` already uses: the gate
(`server/lib/schemaReady.ts`) imports nothing, and `schemaBootstrap.ts` installs
the check into it at import. `services/Schema.ts` imports `schemaBootstrap.ts`,
and `schemaBootstrap.test.ts` asserts the slot is filled, so a lost import is a
red test and a console error rather than a skipped check.

Before importing anything heavy from a `lib/` module, check whether `Repository`
reaches it: `pnpm test:unit:server` is the check, and compare its test count to
`dev`'s, since a collection failure shrinks the total.
