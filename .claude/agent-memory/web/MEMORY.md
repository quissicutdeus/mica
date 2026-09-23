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
- [`callOr`'s default hides failure](callor-default-hides-failure.md) — `[]` on
  failure and `[]` on real-empty are the same value; swap to `call` in place,
  keep the export's name, check `vi.mock` sites outside your fence first
- [Persisted registry has no unregister](persisted-registry-vs-frame-lifecycle.md)
  — don't wire a disposable object (an add-on frame server) into a permanent sdk
  registry; give it its own registry with a real unregister instead
- [A sweep needs a real load signal](hydrate-must-not-sweep-on-every-call.md) —
  don't sweep on every hydrate call; the e2e/dev mock's `[]` looks identical to
  a real empty answer. Also: don't cancel a pending write, exclude its key.
  Also: `pnpm test:e2e -- <files>` from root doesn't filter, use web's
  playwright
- [`derived_inert` only fires for a rune](derived-inert-mechanism.md) — plain
  `svelte/store` derived can't trigger it; real destroy points in this repo, and
  what MICA-266 tried and failed to reproduce
