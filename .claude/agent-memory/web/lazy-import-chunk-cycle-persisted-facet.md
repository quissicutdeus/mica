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
