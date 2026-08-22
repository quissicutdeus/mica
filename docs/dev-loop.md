# The local dev/verify loop

`pnpm verify` is the gate that decides whether a change is done (AGENTS.md §9). It is not
the thing to run after every edit — a cold run costs minutes, most of it e2e and a
production build you don't need feedback on yet. This doc is the fast path underneath it,
and the ticket that produced it: MICA-29.

## Keep a dev server warm

Start one once per session and leave it running in its own terminal:

```
pnpm dev
```

Playwright's `webServer.reuseExistingServer: true` (`web/playwright.config.ts`) and
`scripts/verify.js` both use whatever is already listening on the configured port
(5173 by default) instead of starting their own. A cold start costs about **2.5 minutes**
(Vite plus the add-on watch build); reusing a warm one drops a full e2e run to roughly
**1.6–2.8 minutes for the whole suite** instead of paying that tax on top.

`pnpm dev:check` fails fast with a clear message if nothing is listening, instead of
letting `pnpm test:e2e` or `pnpm verify` silently eat the 2.5 minutes to discover the
same thing:

```
$ pnpm dev:check
Nothing is listening on 5173.

Run `pnpm dev` in another terminal and leave it running for the session —
Playwright and `pnpm verify` both reuse a server already on this port, so
starting one once removes the cold-start tax from every e2e run after it.
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

## Why `pnpm test:unit` (the full one) takes ~2 minutes

Profiled for this ticket, on an already-warm toolchain:

| Suite                   | Wall time | Where it goes                                            |
| ----------------------- | --------- | -------------------------------------------------------- |
| `pnpm test:unit:server` | ~2.6s     | 831 tests, 50 files, node environment — not the problem  |
| `pnpm test:unit:web`    | ~112s     | 958 tests, 119 files — **environment: ~70s of the 112s** |

The `web` project runs `environment: 'jsdom'` with `fileParallelism: false`
(`web/vite.config.ts`), and that serialization is deliberate: `registry.ts` eagerly globs
every app manifest (pulling in the whole `sdk/components.ts` barrel), and under Vitest's
default parallel file/worker model one file's jsdom environment could tear down while
that module graph was still resolving for another file in the same worker, throwing an
`EnvironmentTeardownError` on a run where every assertion actually passed. Serializing
removed the race, at the cost of ~70s of jsdom environment creation/teardown running one
file at a time instead of overlapping.

That tradeoff is the right one to keep for now — a faster suite that's occasionally red
for no real reason is worse than a slower one that isn't. It was **not** re-litigated as
part of this ticket: flipping `fileParallelism` back on and re-running many times to see
whether the race is still live is exactly the kind of experiment that can look safe for a
dozen runs and then flake on CI, and "unit suite got 40% faster" isn't worth "unit suite
is occasionally red for no real reason" (AGENTS.md §9's actual quality gates aren't up for
relaxing here — see this ticket's own Non-goals). The environment cost itself is close to
inherent to jsdom; a real fix would be evaluating a faster DOM implementation
(`happy-dom` is the usual alternative) as a **new dependency**, which needs asking first
per AGENTS.md §2 rule 5 — flagged here as the actual next step rather than attempted
silently.

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
