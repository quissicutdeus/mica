# Building an add-on outside the repo: what actually bites

From MICA-175, all of it verified by building `web/src/apps/notes` from a
directory outside the repo and diffing against `web/public/addons/notes.js`.
`tools/addon-template/` is the artifact; this is the part that is easy to
re-derive wrongly.

## pnpm 11 moved two settings that this depends on

`@gphone/sdk` and `@gphone/shared` are both `private: true` and unpublished, and
the SDK declares `"@gphone/shared": "workspace:*"`. Installing the SDK anywhere
else therefore fails with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`, naming a workspace
the consumer does not have. Fixing it takes an override — and under pnpm 11:

- **A `pnpm` field in `package.json` is ignored.** pnpm prints
  `The "pnpm" field in package.json is no longer read by pnpm` and carries on to
  fail with the same `workspace:*` error, so a `pnpm.overrides` block there
  looks like the fix and does nothing. Overrides go in `pnpm-workspace.yaml`,
  even for a one-package project.
- **`blockExoticSubdeps` defaults to on** and refuses a git dependency reached
  as a subdependency — which is exactly what an override for the SDK's own
  `@gphone/shared` is. `blockExoticSubdeps: false`, same file.

## The git-dependency specifier that works

```jsonc
"@gphone/sdk": "github:quissicutdeus/gPhone#dev&path:/sdk"
"@gphone/sdk": "github:quissicutdeus/gPhone#<40-char sha>&path:/sdk"  // pinned
```

`#path:/sub` alone works too and follows the repository's default branch (`dev`
here). pnpm resolves all of these through **codeload's tarball**, not a clone,
and records the resolved sha in the lockfile — the virtual-store directory name
carries it, which is how you tell which commit a build actually used.

`main` was not usable for this while the packaged `sdk/` (MICA-172) and
`shared/` (MICA-186) existed only on `dev`. That stopped being true on
2026-08-31: `main` carries both, and from `v2026.08.31.44` the release itself
publishes `gphone-sdk-*.tgz` and `gphone-shared-*.tgz` (MICA-125). Pinning a
release tarball is now the better answer than a git specifier for anyone who
wants a version rather than a branch — the tarball's `@gphone/shared` dependency
is a concrete version, so none of the `workspace:*` trouble above applies to it.

## `@gphone/sdk` resolves to the wrong barrel out of tree

The package's `exports` map points `.` at `index.ts` — the **shell** barrel. An
add-on needs `addon.ts`, which the package does not publish under any subpath
(`sdk/publicSurface.test.ts` records that as deliberate, in
`UNPUBLISHED_BY_DESIGN`; adding a subpath for it fails that gate). So an
out-of-tree build has to alias it, exactly as `web/vite.addon.config.ts` does.

Finding the file without a path into the package:
`require.resolve('@gphone/sdk')` returns `index.ts`, so `path.dirname()` of it
is the package root and `addon.ts` is a sibling.
`require.resolve('@gphone/sdk/package.json')` does **not** work — the exports
map does not publish it, and Node's resolver enforces that. Going through
`@gphone/sdk/app.css` (which is published) is the same trick without naming the
wrong barrel in the line above the fix.

Dropping the alias is loud, not silent: `index.ts` does not export `bootAddOn`,
so the build dies with `MISSING_EXPORT`.

## postcss is inherited by accident in tree and must be explicit out of it

`web/vite.addon.config.ts` names no postcss config. It gets
`web/postcss.config.js` because Vite discovers one from the project root, and
the shell build happens to sit in the same directory. Out of tree there is
nothing to inherit.

This is not cosmetic. `sdk/app-utilities.css` — inlined into every add-on bundle
— has ~35 nested `& > …` blocks, and native CSS nesting is **Chromium 112**
against a CEF floor of 103. Without `nesting-rules`, all of them are dropped by
CEF's parser and by nothing else, so the add-on is correct in every browser its
author can open.

Evidence it is reproducible: with the same postcss config, the inlined CSS in an
out-of-tree `notes.js` was **byte-identical** to the in-tree one (41,188 bytes,
`cmp` clean).

## Two reasons an out-of-tree bundle is not byte-identical, neither of them a bug

Building `notes` out of tree at the same commit with the same svelte/vite gave
345,900 bytes against 332,490 in tree. Both differences are explainable:

1. **rolldown emits `//#region <module path>` comments even under
   `minify: true`.** 330 of them, identical in count; only the paths differ
   (`../node_modules/.pnpm/svelte@…` vs
   `node_modules/.pnpm/@gphone+sdk@https+++codeload…`). Worth knowing
   separately: **every add-on bundle this repo ships embeds its build machine's
   module paths.**
2. **Vite does not apply a dependency's own `tsconfig.json` to files under
   `node_modules`.** In tree, `sdk/tsconfig.json` extends `@tsconfig/svelte`,
   which sets `verbatimModuleSyntax: true`, so
   `import { type AsTwin } from './_shared'` in `host/iframe/facets/*.ts` keeps
   the import statement and the module gets a (memoized, side-effect-free)
   initializer call. Out of tree it is elided. Net: **one 10-byte call site**
   across 276 KB — with the region comments stripped, the two bundles differed
   on exactly one line.

So the useful comparison is not `sha256`; it is: same module count (355), CSS
identical, and the JS identical modulo path comments.

## `sdk/host/inProcess/` is not a forbidden directory

A guard that bans it from an add-on graph is wrong and will fail on a correct
build. `sdk/host/iframe/boot.ts` builds its host out of
`inProcess/createInProcessHost`, and `inProcess/system.ts` is shell-free too —
`sdk/seam.test.ts` says so at length. The forbidden set is `web/src/host/` (the
shell-backed facets). If you want a positive assertion instead, check that
`sdk/host/iframe/registerFacets.ts` is in the graph.

## Manifest greps need comments stripped first

`web/vite.addon.config.ts` and `web/scripts/build-addons.mjs` both test
`/core:\s*false/` against **raw** manifest text. A manifest whose comment
mentions the other value is misread — this fired immediately on the template's
own sample manifest, whose doc comment explains what `core: true` means. Strip
block comments and whole-line `//` comments and anchor on
`^\s*core:\s*(true|false)\s*,?\s*$`. The in-tree pair has the same hole pointing
the more dangerous way.
