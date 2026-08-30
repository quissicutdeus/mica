# The local dev/verify loop

`pnpm verify` is the gate that decides whether a change is done (AGENTS.md §9).
It is not the thing to run after every edit — a cold run costs minutes, most of
it e2e and a production build you don't need feedback on yet. This doc is the
fast path underneath it, and the ticket that produced it: MICA-29.

## `pnpm dev`, and why e2e no longer needs it warm

Start one once per session and leave it running in its own terminal, for
manually poking at the phone in a browser while you work:

```sh
pnpm dev
```

This used to matter for e2e too — Playwright's
`webServer.reuseExistingServer: true` would reuse whatever `pnpm dev` had warm
on port 5173, because the dev server compiles modules on demand and a cold graph
took about 2.5 minutes to warm. MICA-36 replaced that:
`web/playwright.config.ts`'s `webServer` now runs `pnpm build:e2e` (a real
build, not `vite dev`) and serves the result with `vite preview` on **4173**,
deliberately off the dev port, with `reuseExistingServer: false` and
`--strictPort`. There is no on-demand compilation left to warm — the build
itself is a one-time, low-double-digit-second step before any test runs, not a
multi-minute tax — and it never looks at 5173 or at whatever `pnpm dev` is
doing. A `pnpm dev` session and an e2e run are now fully independent; one being
warm or cold has no effect on the other.

`pnpm dev:check` still fails fast with a clear message if nothing is listening
on 5173, which is useful before you start manually driving the phone in a
browser — but it buys you nothing before `pnpm test:e2e` or `pnpm verify`
anymore, since neither one touches that port:

```text
$ pnpm dev:check
Nothing is listening on 5173.

Run `pnpm dev` in another terminal and leave it running for the session if you
want to manually drive the phone in a browser. It has no effect on `pnpm test:e2e`
or `pnpm verify`, which build and serve their own copy independently of this port.
```

### When port 4173 is already held

`--strictPort` means a port somebody else has is a loud bind failure rather than
Vite's usual silent fallback to 4174, which is what you want: a suite quietly
testing a stale build on another port is worse than one that refuses to start.

If it is genuinely stuck, the holder may be a **Windows-side** process — under
WSL2, `ss` and `netstat` inside the guest do not see those, so the port looks
free from every tool you would reach for first:

```sh
netstat.exe -ano | grep 4173
```

**This is an environment collision, not a repo defect.** Report it and stop. Do
not "fix" it by changing the port or `web/playwright.config.ts`.

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

Format, full typecheck (all three targets — this repo runs two different
TypeScript versions, see AGENTS.md §3, so a partial typecheck proves nothing
about the other two), and **only the unit tests affected by your uncommitted
changes**, via Vitest's built-in `--changed` (a git-diff-based test selector, no
custom script needed):

```sh
pnpm check:fast
```

No full suite, no build, no e2e, no `deadcode`. This is what the pre-push hook
runs now (`simple-git-hooks.pre-push` in `package.json`) — `pnpm verify:quick`
still exists for CI and for an explicit check before opening a PR, but a hook
that fires on every `git push` doesn't need to run a full production build and
`knip` every time; that's what CI is for.

**Caveat, worth knowing rather than being surprised by:** `--changed` narrows
correctly for ordinary source/test edits (measured: a 3-file change dropped the
web suite from 958 tests / ~112s to 38 tests / ~4.6s), but it falls back to
running the _entire_ suite the moment `package.json`, a lockfile, or
`vite.config.ts` is part of your diff — `web/vite.config.ts` reads
`../package.json` for version metadata, so Vite/Vitest treat a change there as
invalidating the whole dependency graph rather than risk skipping something.
That's the correct call for Vitest to make, not a bug in this script — it just
means `check:fast` runs at full-suite speed while you're mid-edit on a
`package.json` (exactly the case that built this doc). It goes back to being
fast again once that edit is the only thing left uncommitted... or, in practice,
once you commit it.

## Why `pnpm test:unit` (the full one) takes as long as it does

Originally profiled during MICA-29 at ~112s for the `web` project, ~70s of
that being jsdom environment creation/teardown. Two follow-up tickets acted on
that finding:

**MICA-32 tried swapping the DOM implementation** (`jsdom` → `happy-dom`, the
usual faster alternative for a Vitest suite) and reverted it. It really was
faster — the environment phase roughly halved — but it broke `lib/markdown.ts`'s
DOMPurify-based XSS sanitization silently: a `<script>` tag, an `onerror`
handler, and an `<a href>` link all passed straight through un-stripped under
happy-dom, where jsdom correctly strips them, and nothing about that failure was
loud enough to trust switching wholesale. `jsdom` stays the DOM implementation.

**MICA-32 also found the actual fix**, once the diagnosis moved from "which
DOM implementation" to "how many files pay for one at all": most test files in
this suite never touch the DOM. `environment: 'node'` (`web/vite.config.ts`) is
now the _default_ — essentially free to set up — and a file opts into a real
`jsdom` with a `// @vitest-environment jsdom` docblock as its first line.
Getting the classification wrong is loud and immediate
(`ReferenceError: document is not defined`) rather than a silent behavior
change, which is what made this safe to adopt where swapping DOM implementations
wasn't. Net effect: the full `web` suite dropped from ~112s to ~78s, with zero
behavioral risk — every file that touches the DOM still gets a real one. (That
took the suite from ~112s to ~78s at the time. Parallelism, below, took it the
rest of the way to ~12s.)

**`fileParallelism` is on again**, and it is the largest single win in this
loop: the `web` suite runs in ~12s where serialized it took ~70s.

It was off for a real race. `registry.ts` eagerly globs every app manifest
(pulling in the whole `sdk/components.ts` barrel), and under Vitest's parallel
file/worker model one jsdom-environment file could tear down while that module
graph was still resolving for another file in the same worker — an
`EnvironmentTeardownError` on a run where every assertion actually passed.

This page used to argue against turning it back on, in these words: _flipping it
back on to see whether the race is still live is exactly the kind of experiment
that can look safe for a dozen runs and then flake on CI._ That caution is worth
keeping in view rather than deleting, because it is still the right shape of
worry. Three things changed under it:

- **The exposure is much smaller.** MICA-32's own fix means only the ~69
  `@vitest-environment jsdom` files construct a DOM at all. The other ~57 are
  node-environment and were never able to hit a DOM teardown race.
- **Vitest is 4.1.11** now, not the version the race was diagnosed against.
- **The CI those flakes were seen on has itself been overhauled** since —
  MICA-76 took the actions to current versions and added the caching that was
  missing. A good part of what the caution was protecting against was the
  runners, not the test suite, so "it might flake on CI" was a prediction about
  a CI that no longer exists in that form.

Measured before flipping it: five consecutive full runs, 127 files and 1063
tests each, no teardown error and no unhandled rejection. Five runs is still not
a proof about a race, so **if it does come back**, the fix is narrow and is
written beside the flag in `web/vite.config.ts`: give the jsdom files their own
Vitest project with `fileParallelism: false` and leave the node ones parallel.
Setting the flag back to `false` wholesale is the blunt version and costs the
whole minute again. The failure is loud and names `EnvironmentTeardownError`, so
you will not have to guess what happened.

**Adding a new test file:** default to no docblock (fast, `node`). Add
`// @vitest-environment jsdom` as the file's first line if it renders a Svelte
component, touches `document`/`window`/`localStorage` directly, or imports
something that eagerly does (the app registry is the one to watch for). If you
guess wrong, the test fails immediately and obviously — add the docblock and
move on.

## `pnpm test:migrations` — the versioned migrations, against a real database

Opt-in, and **not part of `pnpm verify`**. It needs Docker and pulls
`mariadb:11`, which is not a cost every gate should carry; leaving it out is
what keeps `verify` runnable anywhere. Whether it ever joins the gate is a
separate decision.

```sh
pnpm test:migrations
```

It starts a throwaway MariaDB container on a free port, imports **both**
`gphone.sql` and `gphone.esx.sql`, seeds the states a live server can be in,
runs the migrations, and asserts the result. The container is removed
afterwards, including on failure.

### What it proves that `server/__tests__/` cannot

The unit suites mock `Database`, so a migration test there can assert SQL text
and call ordering and nothing else. That is blind to every question MySQL
answers: whether a statement parses, whether an `ALTER` succeeds against the
rows actually present, whether a constraint rejects what it should.

MICA-153 is the worked example. A draft of `0001` soft-closed its duplicate
rows instead of deleting them, and `UNIQUE (conversation_id, citizenid)` counts
rows rather than live rows — so `ADD UNIQUE KEY` aborted with ER 1062 on the
first database that had the duplicates the migration existed to remove. Every
mocked assertion passed. Re-introducing that bug today fails this harness on the
fixture named `3-CIT_VICTIM`, which is the whole argument for the file.

### It drives the real module, deliberately

`scripts/test-migrations.js` bundles `server/lib/migrations.ts` and
`server/migrations/` with esbuild, installs a real `mysql2` client as
`exports.oxmysql`, and calls the actual `runPendingMigrations`. So the ledger,
the oldest-first ordering, the `information_schema` guards and the
id-to-filename contract all run the way they run on a server.

**Do not "simplify" it into extracting the SQL and piping it to a client.** That
tests a transcription of the migration rather than the migration, which is how
the ER 1062 bug survived a manual check in the first place — the person running
it had hand-assembled the statements, so their idempotency result described
their shell history rather than the file on disk.

It also **regresses the schema before migrating**: `gphone.sql` is generated
from the current declaration, so a fresh import already carries the unique key,
and both guards would find their work done and skip. The harness drops the
unique index, restores the old non-unique one and empties the ledger, so what it
migrates is a server that has genuinely never run this.

### A skip is never a pass

Every path that cannot do the work exits non-zero and says
`Nothing here is a pass`. Docker absent, daemon unreachable, container refusing
to start, schema failing to import — all failures, none of them silent, and
there is no branch that reports success having tested nothing.

The count is checked too: the run fails if fewer assertions execute than
expected, so a fixture that silently seeded nothing cannot print a pass. This is
the same reasoning as `changelog.test.ts`'s "the check fires, rather than merely
being configured".

### Adding a migration to it

The fixtures live in `seedFixtures` and are the regression set for `0001`. A new
migration wants its own fixtures and its own assertions; raise `MINIMUM_CHECKS`
when you add them, or the new checks are not actually required to run.

## Playwright's per-test timeout, and its escape hatch

`web/playwright.config.ts` sets Playwright's own 30-second default
(`timeout: 30_000`). It was briefly 10s, on the reasoning that every test here
that passes does so in under ten and anything approaching thirty is a flake
failing anyway — which was true when measured serially and false under four
workers. A run at that width produced failures at 10.3s through 11.7s, none
hanging and none asserting anything false: the limit was sitting on them rather
than the other way round. The file's own comment carries the full math.

A test that legitimately needs longer than the default — not a flake, just a
test that does more — should still say so itself rather than move the suite-wide
number:

```ts
test('walks through every Settings screen and back', async ({ page }) => {
  test.setTimeout(20_000);
  // ...
});
```

## `lint` is ~2s here and was ~118s in CI, and the cache was the reason

`pnpm verify`'s `lint` gate is ~2-3s locally and cost **118s on every CI run** —
a third of a 316s job — while `.github/workflows/build-test.yml` restored an
ESLint cache each time and its comment claimed a warm run took a second. Both
halves were true: the cache really was restored, and it really did match
nothing.

ESLint's default `cacheStrategy` is `metadata` — file mtime and size, not
content. `actions/checkout` writes every file fresh on every run, so every mtime
differed from the one in the restored cache and all ~865 files were re-linted
under a type-aware config. The cache was inert by construction, not stale or
mis-keyed, so nothing about it looked wrong from the outside.

Reproducing it locally takes one command, and is worth knowing because it is how
you would catch the next one of these:

```sh
cd web
pnpm exec eslint . --cache --cache-location node_modules/.cache/eslint/   # 2.7s
find src -type f \( -name '*.ts' -o -name '*.svelte' \) -exec touch {} +
pnpm exec eslint . --cache --cache-location node_modules/.cache/eslint/   # 122s
```

Not one byte changed between those two runs. `web`'s `lint` script now passes
`--cache-strategy content`, which hashes each file instead, and the same
touch-everything test costs 1.7s.

Prettier was checked the same way and does not have the problem: cold 8.2s, warm
1.9s, and still 1.9s after every mtime in the tree is rewritten.

**The general shape**, since this is the second cache in this repo to be
believed rather than measured: a cache that fails to hit is silent by design —
it just does the work — so "the cache is configured" and "the cache is working"
are different claims and only one of them is checkable. Time the gate.

## Pruning `.claude/worktrees/`

Agent worktrees accumulate. Each one holds a branch checked out, which is why
`git checkout MICA-136` can fail with "already checked out" on a ticket nobody
is working on any more — and why AGENTS.md §2.12 says to take the slugged form
(`MICA-136-player-loaded`) rather than fight it. That is the cheap fix.
Removing the worktree is the real one, and it is the step to be careful about.

**Never blanket-prune.** `git worktree prune` only removes entries whose
directory is already gone; `git worktree remove` on a live directory throws away
whatever is in it. Both are quiet about what they cost you. Walk them:

```sh
git worktree list

for d in .claude/worktrees/*/; do
  printf '\n== %s\n' "$d"
  git -C "$d" status --porcelain
  git -C "$d" log --oneline dev..HEAD
done
```

Two questions per worktree, and both have to answer "nothing":

- **Uncommitted work** — any output from `status --porcelain`. Save it before
  removing anything: `git -C "$d" diff HEAD > /tmp/<branch>.patch`, and say
  where you put it. An untracked file is not in `diff HEAD`; `status` is what
  tells you one exists.
- **Commits ahead of `dev`** — any output from `log dev..HEAD`.

**A branch that was squash-merged still shows commits ahead of `dev`**, because
a squash rewrites the commits into one with a different patch-id. `git cherry`
and `git rebase` both compare patch-ids, so both will tell you the work has not
landed when it has. Do not trust either on a stale branch: check whether **the
content** is on `dev` — `git diff dev -- <the files it touched>`, or read the
lines on `dev` directly. Empty diff, work landed.

Only then:

```sh
git worktree remove .claude/worktrees/<name>
git branch -d <branch>          # -d, never -D: it refuses if the work is unmerged
git worktree prune              # tidies entries whose directory is already gone
```

`git branch -d` refusing is a signal, not an obstacle. It means the branch's
commits are not reachable from anything else, and given the squash caveat above,
it is the last check standing between you and losing work — go and look at
`dev`'s content before reaching for `-D`.

## Testing calls without a second player

Calls are the one feature this loop doesn't otherwise cover — a real one needs a
second connected player. [`docs/testing-voip.md`](testing-voip.md) maps the four
layers that get you most of the way solo, and where each one honestly stops.
