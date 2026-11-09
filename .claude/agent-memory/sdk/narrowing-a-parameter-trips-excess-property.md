# Narrowing a published parameter to `Pick` breaks inline-literal callers

MICA-449 cut `bootAddOn`'s manifest to its `id`, so the frame cannot read a
field the id-only entry no longer passes. A plain `Pick<AppManifest, 'id'>`
parameter looks like a pure widening, and it is for a variable or a spread
argument. An object literal written at the call site is different: each extra
field is TS2353 "Object literal may only specify known properties", under TS 6
and TS 7 alike. A third-party entry that writes its whole manifest inline stops
compiling, and no in-tree caller does that, so no suite here notices.

- **Use a constrained generic**: `<M extends Pick<AppManifest, 'id'>>(m: M)`.
  The literal infers as `M` and is accepted. Reading `m.name` in the body is
  still TS2339 on `M`, which was the point of the narrowing.
- **`expectTypeOf(f).toBeCallableWith(...)` cannot prove that.** It checks the
  arguments against the constraint, not against generic inference, so it reports
  the same excess-property error as the plain `Pick`. Put the real call in an
  arrow that never runs: `expectTypeOf(() => f({...})).toBeFunction()`.
- `Parameters<typeof f>[0]` resolves to the constraint, so
  `toEqualTypeOf<Pick<AppManifest, 'id'>>()` pins the narrowing. It fails if the
  parameter goes back to the whole `AppManifest`.
- `publicSurface.test.ts` reads names, props, hook returns and type shapes. It
  never reads a function's parameter types, so a change here moves no baseline
  and no `SDK_CONTRACT_VERSION`. What to check is whether a caller's code still
  compiles.
