# Many Vite builds from a test: one warm process, not one CLI each

From lane Dogma's cut of `addonTemplate.test.ts` (2026-11-08), about 62 CPU-s
and 25s wall down to 19 CPU-s and 10s, with the same 42 tests.

- A cold `vite build` of the add-on template costs about 2.1 CPU-s; the second
  and later builds in the **same** Node cost about 0.8. Nearly all of a cold
  build is loading and JIT-warming Vite, rolldown's JS side and the Svelte
  compiler, not bundling. Nine CLI processes paid that nine times.
- Vite 8's CLI `build` action is just `createBuilder(inline, null)`, where
  `inline` is `root`, `base`, `mode`, `configFile`, `configLoader`, `logLevel`,
  `clearScreen` and `build`, then `buildApp()` and `runDevTools()`; on a throw
  it logs `error during build:\n${inspect(e)}` and exits 1. `build` is the CLI
  flags minus the global ones, so `--outDir dist` is `{ outDir: 'dist' }`.
  Reproduce that in `web/src/lib/addonTemplateBuilds.mjs`'s way to keep CLI
  fidelity.
- Two pieces of process state differ between builds: `root` is `cwd`, so
  `process.chdir` per build, sequentially (builds in one process cannot run
  concurrently against different working directories); and Vite writes
  `process.env.NODE_ENV` the first time it resolves a config, so put the
  environment back before each build.
- svelte-check is the other big cost (about 6 CPU-s, the whole SDK graph, 550
  files, for a handful in `src/`). One run over several fixtures side by side,
  with `--output machine` and each `"<file>"` diagnostic charged per case, is
  sound under the template's `moduleDetection: force`. Plant a canary that must
  error, or a run that never read the fixtures reads as every case passing.
- Trap: under `pnpm exec vitest`, `PATH` already carries
  `web/node_modules/.bin`, so a copy missing its own `.bin/svelte-check` link
  still finds one. To prove "a script naming a missing binary fails", misspell
  the binary instead.
