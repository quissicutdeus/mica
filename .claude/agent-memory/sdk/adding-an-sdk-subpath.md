# Adding a published subpath to @mica/sdk

MICA-311 published `@mica/sdk/dev` (the add-on template's in-frame service
mock). A new subpath is a one-way door, and `publicSurface.test.ts` has to be
taught it in five places, all keyed by the same entry name:

- `import * as sdkX from './x'` and a row in `ENTRY_POINTS`;
- `ENTRY_FILES` (the typechecker's arm) and `SUBPATH_OF_ENTRY` (the exports-map
  arm, which fails "an entry point no frozen surface covers" otherwise);
- `BASELINE_EXPORTS` and `BASELINE_TYPE_EXPORTS`, each asserted to have exactly
  the `ENTRY_POINTS` keys.

An addition moves no `SDK_CONTRACT_VERSION` and needs no `sdkChangelog` row
unless `PERMISSION_OF` changed; the lead writes the CHANGELOG author line.

Nothing in this repo resolves through the `exports` map: `web/vite.config.ts`
aliases `@mica/sdk` as a **prefix**, so `@mica/sdk/x` there becomes
`../sdk/index.ts/x`. An in-tree test cannot import a template file that imports
the new subpath — test it from an offline template build instead (copy
`tools/addon-template/`, symlink `node_modules/@mica/{sdk,shared}` to this tree
and the toolchain to `web/node_modules`, run Vite's CLI as a child with
`NODE_ENV` and `VITEST*` stripped). `web/src/lib/addonTemplate.test.ts` does
this; five parallel builds cost about three seconds.

`sdk/lib/permissionScan.ts` reads only bare `@mica/sdk` imports, so names from a
subpath never reach the permission table.
