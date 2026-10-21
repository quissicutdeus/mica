# svelte-eslint-parser 1.9.0 finds root's TypeScript 7

`svelte-eslint-parser` 1.9.0 (#607, `e9b1f75`, the JSDoc feature) added
`lib/parser/typescript/javascript.js`, which runs for any `.svelte` file whose
script is not `lang="ts"`: no `<script>` at all, or a bare `<script>`. It calls
`loadNewestModule("typescript")`, which tries three requires (from eslint's
directory, from cwd, from the parser's own directory) and keeps the **highest
version**. From the pnpm virtual store, the eslint and self lookups walk up to
the repo root's `node_modules/typescript`, which is root's TS **7.0.2**, and TS
7's `"."` export is `lib/version.cjs`: `{ version, versionMajorMinor }` and
nothing else. So `ts.NodeFlags` is undefined, and the error reads
`Cannot read properties of undefined (reading 'JavaScriptFile')`.

**Why:** MICA-401, held by MICA-402. On dev at `e4292f51`, `WidgetProbe.svelte`
and `WidgetThrows.svelte` in `web/src/shell/__fixtures__/` are the only
`.svelte` files with no `<script>`. Every other component is `lang="ts"` and
returns early, before the lookup. Bisected: eslint 10.13.0 alone is green; the
1.9.0 parser alone reproduces both errors. No config option reaches this lookup,
and it is unfixed on upstream `main` as of 2026-10-20.

**How to apply:** while root carries `typescript@^7`, any version of this parser
that calls `loadNewestModule("typescript")` breaks script-less and plain-JS
components. Hold it at 1.8.1 with `overrides` in `pnpm-workspace.yaml` (the form
tested here, on pnpm 12.6.0; see [[out-of-tree-addon-build]]), or give such a
file an empty `<script lang="ts"></script>`. Probe resolution from `web/` with a
script that mirrors the three `createRequire` calls before trusting a newer
release.
