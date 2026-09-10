# web agent memory

One file per finding; this index is what loads. Read the file before relying on
its one-line summary.

- [Module-scope `window` breaks node suites](vitest-node-env-window.md) — which
  module graphs take eight suites down on import, and the two fixes
- [Building an add-on outside the repo](out-of-tree-addon-build.md) — pnpm 11
  reads overrides from `pnpm-workspace.yaml` only; the git specifier that works
- [CSP violations in the add-on sandbox](csp-blockeduri-opaque-frame.md) —
  `blockedURI` is an origin from an opaque frame; assert on that, never a path
- [First test pays the cold transform](cold-import-first-test-timeout.md) — on
  the Forgejo runner that is the whole 20s budget; warm the import in
  `beforeAll`, do not raise `testTimeout`
- [A persisted default must not persist](persisted-default-must-not-persist.md)
  — `usePersisted`'s outer `set` always writes storage and queues a debounced
  server save; overlay a runtime default with `derived`, never write it in
