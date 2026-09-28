# The scratchpad is shared with sibling lanes

Every lane in one session gets the same scratchpad directory, so a gate log
named `unit.log` or `tc.log` can be overwritten by another lane's run while
yours is still writing it. Prefix every log with the lane's callsign.

**Why:** on MICA-246 (2026-09-27) a `pnpm test:unit > $S/unit.log` read back a
failure in `apps/places/index.svelte`, a file this lane never touched: a sibling
lane working on Places had written its own run into the same file. The exit code
was 0 and the log said 1 failed, which looked like a gate reporting the wrong
code. Rerun with `howzer-unit.log` was clean.

**How to apply:** name gate logs `<callsign>-<gate>.log`, and when a log names a
file outside the lane's own set, suspect the log before the tree. Also: a
heredoc or a multi-statement Python edit through Bash is refused by the worktree
guard as "too complex"; append to a file with the Edit tool instead.
