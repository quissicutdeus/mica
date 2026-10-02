---
name: lead-protocol
description: >-
  How the lead splits work into lanes, spawns and briefs them, checks what they
  report, integrates, and closes them down. Load before spawning any subagent
  for code in this repo, and again before integrating their commits. The
  lane-side half is `lane-protocol`.
---

# Leading a wave of lanes

Everything here was paid for once. The lane's own half — starting on the right
tree, gating inside its turn, the ten-line report — is `lane-protocol`, which
every code-writing agent type preloads; do not repeat it in a brief.

## The owner's working rules

- **One ticket at a time when building.** Implement, gate, commit and land a
  ticket before starting the next; do not open several tickets' worth of changes
  in one tree. Filing tickets in bulk is fine.
- **The lead owns the record.** `README.md`, `CHANGELOG.md`, `docs/`, Jira
  transitions and every update to the owner come from the lead. Lanes build code
  and tests, report to the lead only, and report a gap rather than close it — a
  lane that hits a red docs gate leaves it red.

## Split the work before naming anyone

A lane owns a **file set**, not a ticket. List the files each ticket touches;
two tickets in one file are one lane with two commits, never two lanes racing.
The lane count is the parallelism the work actually has, not the ticket count,
and a blocked-then-unblocked chain is sequential work for one lane.

Pick each lane's agent type from the directory its files live in (`CLAUDE.md`
has the list); use `review` and `verify` after the lanes report.

**Land the contract before fanning out.** Most tickets here are one NUI round
trip — `shared/contracts/`, a `server/` handler, a `web/` call and mock, often a
`client/` relay — and every directory lane depends on the contract's shape. Left
to whichever lane owns the handler, the others either wait on it or guess it,
and a guessed shape fails `routes.test.ts` only after integration. So the
contract, its `shared/routes.ts` row and the mock in
`web/src/nui/mocks/registry.ts` go first: written by the lead or a single lane,
gated (`pnpm typecheck` plus `routes.test.ts`), committed. Only then do the
lanes spawn, each briefed with that sha and the contract as read-only. A change
to it mid-wave stops the wave: the lead amends it and re-briefs every lane that
reads it. **Resume a lane with `SendMessage`** when follow-up work lands in its
files — it keeps its context, and a fresh `Agent` call starts from nothing.

Callsigns come from a pool and fit the work (`lead.md` has it). Never reuse one
within a session, and never give a lane the lead's name; either makes the
transcript ambiguous about who decided what.

## Spawn mode decides what can collide

- **No `isolation`** — a teammate: its own pane, but it **shares the session's
  working directory**. Several writing teammates can share the main checkout
  only when every brief names a disjoint file fence, says "prettier your own
  files only, never `pnpm format`", and says "do not commit; the lead commits".
- **`isolation: "worktree"`** — a background subagent, no pane, its own tree.
  Required when two lanes need the same file, or a lane needs its own
  `pnpm install`.

While any teammate is live in the main checkout, the lead does not move HEAD
there — no `checkout`, `switch`, `merge` or `reset` — and does not `cd`
anywhere. A lane's `commit --amend` once landed on the lead's merge commit
because the shared directory moved under it. Read other trees with `git -C`, and
run web commands with `pnpm --filter ./web` or in a subshell.

## Brief a lane

Every brief opens with the exact tip sha and the spawn mode. A worktree lane
resets onto that sha, since worktrees are cut stale; a teammate in the shared
checkout must never reset there, and stops and reports a mismatch instead —
`lane-protocol` carries both, so name which one this lane is. A teammate's
report opens with `uncommitted:` and its paths rather than a sha. Then:

- the file fence, the sibling lanes' files as off-limits, and "stop and report
  rather than edit outside it";
- `README.md`, `CHANGELOG.md`, `docs/` and Jira as off-limits;
- the **exact** gate commands: `prettier --check` on its files, one typecheck
  target, `vitest run` on its own test files **and every suite that mocks a
  module it changes**, `pnpm lint:ts`, plus `pnpm lint:web` or `pnpm lint:sdk`
  for those directories. Never `pnpm verify` in a lane;
- the lane's callsign, which `lane-protocol` uses to name its scratchpad logs;
- any e2e spec a lane names in its report goes to the `verify` lane;
- for a lane writing a FiveM export: read `GetInvokingResource()` into a const
  on the first synchronous line, since after an `await` it is null and no stub
  shows it;
- for `review` lanes: never `checkout` or `switch` in the main checkout;
- agent-memory notes: an H1, no frontmatter, wrapped at 80 columns.

Send the long brief once, then — if the lane idles without starting — a separate
five-line message: what is already committed, the brief is in your inbox, **do
not reply to this**, send exactly one message when done or blocked. A long
message reads as something to answer instead of something to execute.

## A report is a claim

- **Check the tree before believing a notice.** Idle notices arrive late and out
  of order, often describing work already committed, or predating the message
  you just sent.
- **Diff each lane commit for scope.** A lane once ran a spelling pass "per your
  mid-task correction" that nobody sent; another reported a commit holding
  eleven files it never staged.
- **Check every coverage claim with a grep.** "No e2e spec covers this" was
  wrong twice; "one `$derived` file" was 81.
- Resolve every SHA pin a lane adds with `gh api` before merging; all its gates
  passing proves the gates, not the pins.
- Verify the load-bearing claim of a finding before relaying it to the owner.

## Integrate

- **One `verify` lane runs Playwright for the whole wave.** Two runners collide
  on port 4173 and `web/dist`; lanes send it spec files.
- With lanes that build on each other, `git cherry-pick -n` in order, then prove
  each file equals its lane tip with `git diff --quiet <tip> -- <file>`.
- **Run a full `pnpm verify` over the exact tree a ticket lands in before
  committing it.** `pre-push` runs `check:fast`, which does not lint, and
  committing on lane gates alone turned CI red twice. With several lanes in one
  checkout, run it when no lane is mid-edit and commit per ticket by path.
- A background gate writes its rc to a file and you read the file; the task
  notice reports the wrapper's exit, not the gate's. After a partial failure
  rerun only the gate that failed.
- **Send a `review` lane before committing server code that writes player
  data**, and again after any rewrite of a delete path. Each review round on
  such code has found a real must-fix after every suite was green.
- Splitting entangled work into commits: back up the whole diff and untracked
  files, stage one commit, `git stash push --keep-index --include-untracked`,
  gate that exact tree, commit, `git stash pop --index`, then diff the restored
  tree against the backup.

## Close it down

- **Stop a `review` lane (`TaskStop`) as soon as its findings are fixed or
  rejected.** An idle reviewer holds its pane all session.
- **Keep a writing lane, and its worktree, until its ticket lands.** A stopped
  teammate cannot be resumed by `SendMessage`, and a lane whose worktree was
  removed cannot continue; fixes found in review then fall to the lead.
- Run `ListAgents` before telling the owner a wave is done.
- Remove a lane worktree, then delete both its ticket branch and the
  `worktree-agent-*` branch, which survives the worktree.
- Keep a `git push` in a Bash call of its own — the bash guard can refuse a
  whole call for one part of it — and move a Jira ticket only after the push's
  output confirms it.

## If the lead's session dies

A dead lead is respawned blank by the next idle notice. Grep the project's
transcripts for a lane's callsign to find the old session — names recur across
sessions, so take the newest transcript that spawned it — read its `Agent`
spawns for the roster and briefs and its turns for lane reports, then land from
what is on disk.
