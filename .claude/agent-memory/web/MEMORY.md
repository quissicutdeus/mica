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
- [`derived_inert` only fires for a rune](derived-inert-mechanism.md) — needs
  dirty+INERT/DESTROYED at once; store-backed deriveds sever on unmount before
  they can be dirtied; two real hits fixed (Trade.svelte, License.svelte)
- [Mocking `nui/fetchNui` misses CRUD stores](fetchnui-mock-misses-crud-stores.md)
  — `createCrudStore` uses the SDK transport; `.set()` it in the test. `svc`
  calls carry a 3rd arg, so `toHaveBeenCalledWith` fails on arity
- [Lazy shell import kills boot](lazy-import-chunk-cycle-persisted-facet.md) —
  chunk cycle evaluates state modules before facets register; import statically
  or eager; worktree+symlink trap
- [Prove a move by handler source](prove-a-move-by-handler-source.md) — keys
  aren't enough; compare `String(fn)` with `__vite_ssr_import_N__.` stripped;
  knip follows `import.meta.glob`
- [A build-flag gate folds](build-flag-gate-and-persist-proof.md) —
  `DEV || VITE_X` dynamic import emits no chunk; prove it on a scratch outDir;
  "persists nothing" needs both a storage snapshot and `saveSetting` unspied
- [Mock files are scanned as text](mock-files-are-scanned-as-text.md) —
  routes.test needs 2-space keys and a bare-identifier `defineMockCrud` first
  arg; handlers get `{ device }`
- [A mocked promise is never unhandled](mocked-promise-is-never-unhandled.md) —
  `vi.fn` handles what it returns; spy on the promise's `catch` instead of
  listening for `unhandledRejection`
- [Assert a fake-timer count as a difference](fake-timer-count-is-relative.md) —
  `recordConsent` queues its own debounced timer; and `waitFor` needs
  `shouldAdvanceTime`
- [The Bash guard reads a regex `|` as a pipe](bash-guard-reads-regex-pipe.md) —
  `grep -E "a|b"` beside a gate drops the batch; filter logs with `-e` flags
- [`__resetAppEvents` wipes module subscribers](reset-app-events-wipes-module-subscribers.md)
  — import-time subscribers never re-register; drain with `clearAppEvents`
- [No `<form>` submit in an add-on](no-form-submit-in-addon-frame.md) — the
  frame lacks `allow-forms`; the handler silently never runs; click + Enter
- [A union state does not narrow in `{:else if}`](svelte-template-union-narrowing.md)
  — passes typecheck, fails `lint:web`; split the state. `ReportDialog` needs
  `reports` + `notifications`
- [A new app trips two pins](new-app-trips-two-pins.md) — appContract `APPS` row
  and the computed-class ratchet (Icon `class={className}`); `run()` answers a
  boolean
- [`Object.hasOwn`/`.at()` fail web's typecheck](es2022-lib-gap-object-hasown.md)
  — CEF has them, web's TS lib does not. Plus the utilities that look real and
  aren't (`mx-4`, `pt-6`, `bg-gray-900`)
- [A `.svelte` module-script type fails lint](svelte-module-script-type-export.md)
  — typecheck passes, eslint sees `error` types; declare it in `store.ts`
  instead
- [jsdom keeps `inert` as a property](jsdom-inert-is-a-property.md) — Svelte
  sets `el.inert`; jsdom never reflects it, so `hasAttribute('inert')` is false
- [Read the sibling server file first](sibling-server-contract-drift.md) — a
  brief's contract drifted from the parallel server lane (returned refusals,
  other slugs); handle returned and thrown refusals, then run `routes.test`
- [A throwing store subscriber wedges every store](store-subscriber-throw-wedges-every-store.md)
  — Svelte's shared queue never drains again; clone-check pushes in tests;
  dedupe a scoped derived yourself
- [axe 4.14 turns on `label-content-name-mismatch`](axe-414-label-content-name-mismatch.md)
  — now on by default, matches whole words; `aria-hidden` does not exempt
  visible text
- [svelte-eslint-parser 1.9.0 finds root's TypeScript 7](svelte-eslint-parser-finds-root-ts7.md)
  — crashes on script-less components; held at 1.8.1 by MICA-402's override
