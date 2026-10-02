---
name: lane-protocol
description: >-
  How a lane (a subagent spawned by the lead) starts on the right tree, runs a
  gate to completion, proves a check actually fires, and shapes its final
  report. Preloaded by every code-writing agent type so this isn't repeated in
  each one; the agent's own Report section still names what is specific to it.
---

# Starting, gating, and reporting as a lane

## Start on the tree you were given

`git log -1 --format=%H` first, and compare it to the sha in the brief. Which
fix is safe depends on whose tree it is, so check that before touching it:
`git rev-parse --show-toplevel` under `.claude/worktrees/` is yours; anywhere
else is the **shared main checkout**, where sibling lanes are editing too.

- **Your own worktree:** it is cut from wherever the harness thinks HEAD is, not
  from `dev`'s tip, so it is usually behind. `git reset --hard <sha>` onto the
  brief's tip before reading a line — from a working directory already inside
  the worktree, or as `git -C <worktree> reset --hard <sha>`. The Bash guard
  refuses one behind a `cd` in the same command, since it cannot tell which tree
  that resets.
- **The shared main checkout:** never `reset`, `checkout`, `switch`, `stash` or
  `commit` there. A `reset --hard` in it erases every sibling lane's unsaved
  work with no way back, and the Bash guard refuses one over a dirty tree
  outside `.claude/worktrees/`. If the sha does not match, stop and report the
  mismatch; the lead moves HEAD, not you.

Say so if the brief named no sha. Work built on the wrong base merges as a
conflict or, worse, cleanly.

## The scratchpad is shared with your siblings

Every lane in a session gets the same scratchpad directory. Name every log and
rc file `<callsign>-<gate>.log` / `.rc` — a bare `unit.log` has been overwritten
mid-run by a sibling's gate, and read back as a failure in a file this lane
never touched (MICA-246). When a log names a file outside your fence, suspect
the log before the tree.

## Run a gate to completion inside your turn

In the foreground with a long timeout, or in the background with an `until` loop
on its rc file in the same call. Ending a turn "while the gate finishes" ends
the task with no result — the lead cannot see the process, only your report.
Never pipe a gate: `cmd | tail` reports `tail`'s exit code.

## Lint is two commands, and neither is the other

`pnpm lint:ts` is oxlint over everything; `pnpm lint:web` is ESLint over `web/`
(tests and e2e specs included) and `pnpm lint:sdk` over `sdk/`. A lane that
touched `web/` or `sdk/` and ran only `lint:ts` has not linted its files: on
2026-09-29 two lanes' test files passed `lint:ts` and failed the lead's verify
on `no-unnecessary-type-assertion`. Run the one for every directory you touched.

## A warm typecheck can lie after a `.d.ts` change

TS 7 caches in `node_modules/.tmp/*.tsbuildinfo`, and after a global declaration
file is added or edited a warm `tsc` has reported both stale errors and a false
pass (MICA-237). Delete the target's `.tsbuildinfo`, or pass
`--incremental false`, before the typecheck you report whenever your change
touches a `.d.ts`. CI has no cache, so CI is right when the two disagree.

## Prove a check fires

Break the code with the Edit tool, run the gate as its own Bash call with
literal paths, restore with Edit, then rerun the real gate. A one-liner that
rewrites a file through a shell variable is refused by the worktree guard and
proves nothing.

## Find the e2e spec before you say there is none

Before writing "no e2e spec covers this", grep `web/e2e` for the testids,
labels, store names and behaviors in your diff. If one matches, name it for the
lead; run it yourself only when the brief says port 4173 is yours, since another
lane may hold it. A spec that pins the behavior you removed turns the full
verify red long after your own gates were green (MICA-194). "No e2e spec covers
this" has been wrong twice.

## Report

Your final message goes to the lead, who is short on attention. **Ten lines at
most** — no headers, no tables, no restating the brief. The first line is the
sha of your commit, which the lead cherry-picks, reading nothing you did not
commit; in the shared main checkout, where you do not commit, it is
`uncommitted:` and the exact paths you changed, so the lead can stage them by
path. A gate you ran is one line: the command, pass or fail, and the counts it
printed. Paste output only for a failure, and only the failing part. Then the
e2e spec line above. The rest of the ten lines is whatever your agent type's own
Report section asks for beyond this.
