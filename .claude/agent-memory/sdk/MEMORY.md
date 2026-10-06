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
- [Tooling an add-on runs](tooling-an-addon-runs.md) — `checks/` is JS (no type
  stripping in node_modules); spread, not extend; stylelint misses `color-mix()`
