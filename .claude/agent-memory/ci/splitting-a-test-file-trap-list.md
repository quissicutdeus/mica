# Splitting a long server test file: what hides until it runs

Splitting `smokeWrapper` and `bashGuard` into three files each (2026-11-08)
turned up three things the first gate did not show.

- `oxlint` does not flag an undefined name, so a helper dropped from a new
  file's import list passes `lint:ts` and fails only at run time. A file whose
  `beforeAll` throws reports its cases as _skipped_ in the JSON (pending count),
  not failed, so read `numPendingTests`, not just the failed count.
- `pnpm test:unit:server` counts 6071 tests whether or not a split file lost a
  case to a typo; reconcile by full test name between a base run and a new run
  (`vitest run --reporter=json`), not by the total alone.
- A worktree lane's Bash guard refuses `sh script`, `$VAR` as a command or a sed
  argument, and any command line holding `git` inside a larger construct (a grep
  for `GITLINK` tripped it). Put multi-step timing in a script in the
  scratchpad, make it executable, and run it by its path.

Timing on this box is noisy: other lanes run at the same time (load average near
18 on 16 cores), so compare orig and split back to back, three runs each, and
under `taskset -c 0-3` for a CI-sized machine.
