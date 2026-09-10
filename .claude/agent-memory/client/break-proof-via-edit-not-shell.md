---
name: break-proof-via-edit-not-shell
description:
  In an isolated worktree the harness refuses a shell command that runs a
  program built from variables (node -e with $F); break a check with Edit, run,
  restore with Edit
metadata:
  type: feedback
---

To prove a test fires by breaking the code, break it with the Edit tool, run the
gate as its own Bash call with literal paths, then restore with Edit. Do not
script the backup-break-run-restore as one shell line.

**Why:** on MICA-234 (2026-09-10) a one-liner that copied
`client/lib/ownerConfig.ts` aside, rewrote it with `node -e` reading a `$F`
variable, ran vitest and copied it back was refused outright by the
worktree-isolation guard: a program computed at runtime cannot be shown not to
be git. Nothing ran, so nothing needed restoring, but it cost a round trip.

**How to apply:** any lane brief that says "prove one fires by breaking the
code". Three calls in sequence -- Edit (break), Bash (the gate, output to a
scratchpad file, `echo rc`), Edit (restore) -- and rerun the real gate after the
restore before committing.
