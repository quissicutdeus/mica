# sdk agent memory

One file per finding; this index is what loads. Read the file before relying on
its one-line summary. A change to the public surface that broke something no
suite here builds, or a permission row that disclosed more than its name, goes
in its own file and gets a line here.

- [Overloads and generic types](overloads-and-generic-types.md) — put the
  general overload last; a type-argument type has no shape (MICA-308)
- [Adding a published subpath](adding-an-sdk-subpath.md) — five places in
  publicSurface; in-tree aliases bypass `exports`; test via offline build
- [shared/ compiles under client and server](shared-compiles-under-client-and-server.md)
  — no `URL` there; `../sdk` filter runs shared tests twice
- [Typed store front doors](typed-store-front-doors.md) — loosest impl
  signature, conditional params still infer, TS 6/7 overload errors, strict
  add-on input
- [Tooling an add-on runs](tooling-an-addon-runs.md) — `checks/` is JS (no type
  stripping in node_modules); spread, not extend; stylelint misses `color-mix()`
- [Errors across the iframe wall](errors-across-the-iframe-wall.md) — encode in
  `fail`, rebuild in `remoteCall`, mirror in devMock; `crossWall` is the e2e
  test
- [Removing from index.ts is not a bump](index-barrel-removal-is-not-a-bump.md)
  — shell barrel is unpublished; edit the baseline with a comment, guard with
  `NEVER_EXPORTED`
- [A facet store's methods vanish in a frame](facet-store-methods-vanish-in-a-frame.md)
  — twin stores are bare `Readable`; feature-test, fall back to an answered
  member
- [Waiting on a first push](waiting-on-a-first-push.md) — a refused subscribe
  never replies; seed `undefined`, bound the wait; device switch rebuilds the
  frame
- [Adding a host facet](adding-a-facet.md) — eleven places; the
  `APP_SCOPED_FACETS` pin fails open if forgotten, so name it in a test
- [Props baseline misread inline types](props-baseline-misreads-inline-types.md)
  — fixed MICA-395; a new props form fails loud, add a fixture, never a row
- [A contract bump has runtime reach](contract-bump-has-runtime-reach.md) — old
  `sdkContract` refused, catalog URL moves, CHANGELOG `v<n>` needed
- [A string store's name is a label](string-store-name-is-a-label.md) — frame
  check is `origin === 'null'`, not `window.parent`; `service` not defaulted
- [Add-on hook types are narrower](add-on-hook-types-are-narrower.md) — rows are
  the wire not the surface; named export beats `export *`; own baseline arm
