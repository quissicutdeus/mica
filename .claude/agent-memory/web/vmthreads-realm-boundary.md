# vmThreads puts a realm boundary inside jsdom files

Since the web Vitest project moved to `pool: 'vmThreads'` (2026-11-08), a jsdom
file's `globalThis` is jsdom's window in a VM context, but some of what it sees
is Node's own realm. Three shapes it took, each passing under `--pool=forks`:

- **`structuredClone` returns Node-realm objects.** Vitest lends Node's in
  because jsdom has none. Plain objects still `toEqual`, but a Map or Set fails
  (`iterableEquality` checks `a.constructor === b.constructor`), and
  `Object.getPrototypeOf(clone) === Object.prototype` is false. Fixed in
  `IframeHostServer.test.ts` with a file-local `expect.addEqualityTesters` that
  rebuilds both sides via `util.types.isMap`/`isSet`, and by comparing against
  `Object.getPrototypeOf(structuredClone({}))`.
- **jsdom's `window.postMessage` never fires under fake timers.** jsdom queues
  it on `setImmediate` read from its own module scope, i.e. the host global;
  `vi.useFakeTimers()` patches the VM global. `vi.advanceTimersByTime` delivers
  nothing; `vi.waitFor` (real-timer polling) works in both pools.
- **jsdom's `crypto` has no `subtle`.** `web/src/test/setup.ts` lends Node's
  `webcrypto.subtle`.

Diagnose a vm-only failure by running the one file with `--pool=forks`.

Also: `pnpm test:unit:web -- --pool=forks <files>` silently ignores **both** the
pool and the file filter — vitest gets them after a literal `--` and runs the
whole suite on the configured pool. Drop the `--`.

Memory: per-worker VM contexts accumulate until `vmMemoryLimit` (set to 512MB;
the default is 1/maxWorkers of RAM). The comment in `web/vite.config.ts` has the
measurements.
