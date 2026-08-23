# The local dev/verify loop

`pnpm verify` is the gate that decides whether a change is done (AGENTS.md §9). It is not
the thing to run after every edit — a cold run costs minutes, most of it e2e and a
production build you don't need feedback on yet. This doc is the fast path underneath it,
and the ticket that produced it: MICA-29.

## `pnpm dev`, and why e2e no longer needs it warm

Start one once per session and leave it running in its own terminal, for manually poking
at the phone in a browser while you work:

```
pnpm dev
```

This used to matter for e2e too — Playwright's `webServer.reuseExistingServer: true`
would reuse whatever `pnpm dev` had warm on port 5173, because the dev server compiles
modules on demand and a cold graph took about 2.5 minutes to warm. MICA-36 replaced
that: `web/playwright.config.ts`'s `webServer` now runs `pnpm build:e2e` (a real build,
not `vite dev`) and serves the result with `vite preview` on **4173**, deliberately off
the dev port, with `reuseExistingServer: false` and `--strictPort`. There is no on-demand
compilation left to warm — the build itself is a one-time, low-double-digit-second step
before any test runs, not a multi-minute tax — and it never looks at 5173 or at whatever
`pnpm dev` is doing. A `pnpm dev` session and an e2e run are now fully independent; one
being warm or cold has no effect on the other.

`pnpm dev:check` still fails fast with a clear message if nothing is listening on 5173,
which is useful before you start manually driving the phone in a browser — but it buys
you nothing before `pnpm test:e2e` or `pnpm verify` anymore, since neither one touches
that port:

```
$ pnpm dev:check
Nothing is listening on 5173.

Run `pnpm dev` in another terminal and leave it running for the session if you
want to manually drive the phone in a browser. It has no effect on `pnpm test:e2e`
or `pnpm verify`, which build and serve their own copy independently of this port.
```

## The fast loop for one file or feature

None of these need the full suite:

| What changed           | Command                                                 |
| ---------------------- | ------------------------------------------------------- |
| One web unit test      | `pnpm --filter web exec vitest run <path>`              |
| One server/client test | `pnpm exec vitest run <path>` (root `vitest.config.ts`) |
| One e2e spec           | `pnpm --filter web exec playwright test <path>`         |
| Types, one target      | `pnpm typecheck:client` · `:server` · `:web`            |
| Formatting             | `pnpm format`                                           |

## `pnpm check:fast` — the named middle ground

Format, full typecheck (all three targets — this repo runs two different TypeScript
versions, see AGENTS.md §3, so a partial typecheck proves nothing about the other two),
and **only the unit tests affected by your uncommitted changes**, via Vitest's built-in
`--changed` (a git-diff-based test selector, no custom script needed):

```
pnpm check:fast
```

No full suite, no build, no e2e, no `deadcode`. This is what the pre-push hook runs now
(`simple-git-hooks.pre-push` in `package.json`) — `pnpm verify:quick` still exists for CI
and for an explicit check before opening a PR, but a hook that fires on every `git push`
doesn't need to run a full production build and `knip` every time; that's what CI is for.

**Caveat, worth knowing rather than being surprised by:** `--changed` narrows correctly
for ordinary source/test edits (measured: a 3-file change dropped the web suite from
958 tests / ~112s to 38 tests / ~4.6s), but it falls back to running the _entire_ suite
the moment `package.json`, a lockfile, or `vite.config.ts` is part of your diff —
`web/vite.config.ts` reads `../package.json` for version metadata, so Vite/Vitest treat a
change there as invalidating the whole dependency graph rather than risk skipping
something. That's the correct call for Vitest to make, not a bug in this script — it just
means `check:fast` runs at full-suite speed while you're mid-edit on a `package.json`
(exactly the case that built this doc). It goes back to being fast again once that edit
is the only thing left uncommitted... or, in practice, once you commit it.

## Why `pnpm test:unit` (the full one) takes as long as it does

Originally profiled during MICA-29 at ~112s for the `web` project, ~70s of that being
jsdom environment creation/teardown. Two follow-up tickets acted on that finding:

**MICA-32 tried swapping the DOM implementation** (`jsdom` → `happy-dom`, the usual
faster alternative for a Vitest suite) and reverted it. It really was faster — the
environment phase roughly halved — but it broke `lib/markdown.ts`'s DOMPurify-based XSS
sanitization silently: a `<script>` tag, an `onerror` handler, and an `<a href>` link all
passed straight through un-stripped under happy-dom, where jsdom correctly strips them,
and nothing about that failure was loud enough to trust switching wholesale. `jsdom` stays
the DOM implementation.

**MICA-32 also found the actual fix**, once the diagnosis moved from "which DOM
implementation" to "how many files pay for one at all": most test files in this suite
never touch the DOM. `environment: 'node'` (`web/vite.config.ts`) is now the _default_ —
essentially free to set up — and a file opts into a real `jsdom` with a
`// @vitest-environment jsdom` docblock as its first line. Getting the classification
wrong is loud and immediate (`ReferenceError: document is not defined`) rather than a
silent behavior change, which is what made this safe to adopt where swapping DOM
implementations wasn't. Net effect: the full `web` suite dropped from ~112s to ~78s, with
zero behavioral risk — every file that touches the DOM still gets a real one.

`fileParallelism: false` (`web/vite.config.ts`) is unrelated and unchanged by either
ticket: `registry.ts` eagerly globs every app manifest (pulling in the whole
`sdk/components.ts` barrel), and under Vitest's default parallel file/worker model one
jsdom-environment file could tear down while that module graph was still resolving for
another file in the same worker, throwing an `EnvironmentTeardownError` on a run where
every assertion actually passed. Serializing removed the race — now paid only by the
`@vitest-environment jsdom` files, a smaller set than before, but the same tradeoff:
flipping it back on to see whether the race is still live is exactly the kind of
experiment that can look safe for a dozen runs and then flake on CI, and was explicitly
out of scope for both tickets.

**Adding a new test file:** default to no docblock (fast, `node`). Add
`// @vitest-environment jsdom` as the file's first line if it renders a Svelte component,
touches `document`/`window`/`localStorage` directly, or imports something that eagerly
does (the app registry is the one to watch for). If you guess wrong, the test fails
immediately and obviously — add the docblock and move on.

## Playwright's per-test timeout, and its escape hatch

`web/playwright.config.ts` sets a 10-second default (`timeout: 10_000`), down from
Playwright's own 30s default — real assertions in this suite resolve in under 2s, and a
30s wait on a genuine flake was pure wasted time (see the file's own comment for the math).

That default is occasionally too short for a legitimately long test — not a flake, just a
test that does more: one Settings e2e case (ten clicks, two navigations, a reload)
legitimately needs closer to 20s. Don't raise the suite-wide default for one slow test.
Override it in that test:

```ts
test('walks through every Settings screen and back', async ({ page }) => {
  test.setTimeout(20_000);
  // ...
});
```
