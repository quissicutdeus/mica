# The first test in a file pays the cold transform, and on the runner that is 20s

From the five red Verify runs on `dev` between `5779b36a` (run 76) and
`3da23e9b` (run 80), 2026-09-09 to 2026-09-10 — one test, every run.

- `web/`'s Vitest project isolates files, so each test file re-imports its
  module graph. The transform is cached per worker; the execution is not. The
  **first** import of a heavy graph in a fresh worker pays the transform, and a
  `vi.resetModules()` re-import afterwards costs about 20ms.
- `services/admin.test.ts` re-imports `./admin` per test through `loadAdmin`,
  and `admin.ts` imports `isBrowser` from the `@mica/sdk` barrel, so that file's
  first test transforms the SDK, the contracts and the NUI call. Locally 0.8s.
  On the Forgejo runner (an i7-4770K with eight workers contending) it took
  20,077–20,095ms — the 20s `testTimeout` to within a tenth — on every push
  after wave two grew the graph. The other five tests in the file took 18–34ms.
- The fix: pay the cold import once in a hook with its own ceiling, so the
  per-test timeout goes back to meaning "hung".

  ```ts
  beforeAll(async () => {
    await import('./admin');
  }, 60_000);
  ```

  Locally the first test fell from 804ms to 31ms. Do not raise `testTimeout` for
  this class — it was already raised from 5s to 20s for the same runner in
  `a395ca9b`, and the graph will grow again.

- Symptom to recognise: `Test timed out in 20000ms` on the first `it` of a file
  whose `loadX` helper does `vi.resetModules()` plus a dynamic import; green
  locally, red only on the runner, with a duration within 100ms of the timeout.
