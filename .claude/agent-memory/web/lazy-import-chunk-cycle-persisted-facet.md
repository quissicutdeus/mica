# A lazy shell import can kill boot: persisted facet not loaded

A dynamic `import()` (or a non-eager `import.meta.glob`) of a shell component
whose imports include `state/time`, `state/charge`, `state/airplane` or
`addon/srcdoc` splits those modules into their own chunk. Rollup then orders
that chunk against the SDK chunk in a cycle, evaluates it before
`host/registerFacets` has run, and every e2e spec dies on a pageerror. Vitest
and typecheck stay green; only a built bundle shows it.

Fix: import such shell-side code statically (`AddOnFrame` in `Shell.svelte` is
the precedent) or use `{ eager: true }`. A core app's own manifest `load` is
lazy by contract and has been fine.

Find the culprit fast: `vite preview` the built bundle and read the `pageerror`
stack with a small playwright script; the offending chunk is named in the frame.
To bisect against a clean base, use a `git worktree` with `node_modules`
symlinked — and never `git worktree remove --force` it while those symlinks
exist: it deleted `web/node_modules` links in the main checkout. Unlink them
first.

**It also happens the other way round (MICA-311).** A dynamically imported
_dev-only_ module that makes a value import from the shell's own graph
(`registry`, `navigation`, `toast`, the shell's `messages`) makes Rolldown split
those modules out of the entry into a shared chunk, and the same failure
follows. You cannot import it statically, because it has to fold out of the game
build. Instead, have `Shell.svelte` pass the pieces in as arguments
(`startDevAddOn(deps)`, `t` as a prop) and keep the module to `import type`. A
quick check: `grep 'from"./' assets/<chunk>-*.js` should name only `vendor`.
`devAddOn.test.ts` enforces the import rule.
