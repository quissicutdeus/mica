---
name: lane-protocol
description:
  How a lane (a subagent spawned by the lead) starts on the right tree, runs a
  gate to completion, proves a check actually fires, and shapes its final
  report. Preloaded by every code-writing agent type so this isn't repeated in
  each one; the agent's own Report section still names what is specific to it.
---

# Starting, gating, and reporting as a lane

## Start on the tree you were given

`git log -1 --format=%H` first, and compare it to the sha in the brief. A
worktree is cut from wherever the harness thinks HEAD is, not from `dev`'s tip,
so the tree you were handed is usually behind; `git reset --hard <sha>` onto the
brief's tip before reading a line, and say so if the brief named none. Work
built on the wrong base merges as a conflict or, worse, cleanly.

## Run a gate to completion inside your turn

In the foreground with a long timeout, or in the background with an `until` loop
on its rc file in the same call. Ending a turn "while the gate finishes" ends
the task with no result — the lead cannot see the process, only your report.

## Lint is two commands, and neither is the other

`pnpm lint:ts` is oxlint over everything; `pnpm lint:web` is ESLint over `web/`
(tests and e2e specs included) and `pnpm lint:sdk` over `sdk/`. A lane that
touched `web/` or `sdk/` and ran only `lint:ts` has not linted its files: on
2026-09-29 two lanes' test files passed `lint:ts` and failed the lead's verify
on `no-unnecessary-type-assertion`. Run the one for every directory you touched.

## A warm typecheck can lie after a `.d.ts` change

TS 7 caches in `node_modules/.tmp/*.tsbuildinfo`, and after a global declaration
file is added or edited a warm `tsc` has reported both stale errors and a false
pass. Delete the target's `.tsbuildinfo` before the typecheck you report
whenever your change touches a `.d.ts`.

## Prove a check fires

Break the code with the Edit tool, run the gate as its own Bash call, restore
with Edit. A one-liner that rewrites a file through a shell variable is refused
by the worktree guard and proves nothing.

## Report

Your final message goes to the lead, who is short on attention. **Ten lines at
most** — no headers, no tables, no restating the brief. The first line is the
sha of your commit; the lead cherry-picks it and reads nothing you did not
commit. A gate you ran is one line: the command, pass or fail, and the counts it
printed. Paste output only for a failure, and only the failing part. The rest of
the ten lines is whatever your agent type's own Report section asks for beyond
this.
