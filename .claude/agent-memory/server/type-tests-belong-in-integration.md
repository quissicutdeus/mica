# A type-level test only runs where a tsconfig reads it

**Partly stale since MICA-320.** `pnpm typecheck` now has a `tests` target
(`scripts/check-test-types.js`) that compiles `server/` and `client/` test files
against `scripts/test-types-baseline.txt`; a file not in the baseline fails on
any error. MICA-341 hit it: `Array.prototype.at` is outside the client tests'
`lib` (TS2550). The rest below was true before that target existed and still
holds for `shared/*.test.ts`.

Before MICA-320, no tsconfig read a test file on the server side.
`server/tsconfig.json` and `client/tsconfig.json` exclude `__tests__` and
`../shared/**/*.test.ts`, and `shared/*.test.ts` runs under the web Vitest
project, which svelte-check does not cover either. So `expectTypeOf(...)` and
`// @ts-expect-error` in any of those files is documentation: vitest does not
typecheck, and the line passes whatever the types say.

`integration/tsconfig.json` includes everything under `integration/`, and
`pnpm typecheck:integration` is one of the five `pnpm typecheck` targets.
MICA-308 put its inference proof there
(`integration/scenarios/addonService.ts`): an `Equal<A, B>` helper constrained
to `true`, plus `@ts-expect-error` lines, which TS reports as "Unused" when the
error they expect stops happening. Break one assertion and run the target to
prove it fires.

Two traps hit on the way:

- A line that throws at run time (a `defineAddonService` call that is meant to
  be refused) must not run at module scope in a scenario file: it takes the
  whole harness down. Express it as a type-only check (`void (x satisfies T)`).
- Prettier reflows a long expression, and `@ts-expect-error` covers only the
  next line. Put the directive directly above the property that errors, after
  formatting, or it turns into "Unused directive" plus the real error.
