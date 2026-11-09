# `pkill -f` matches the Bash tool's own shell

The Bash tool runs each command as `zsh -c '<your whole command line>'`, so
`pkill -f "vite preview --port 4394"` matches that zsh process too and kills it
mid-batch: the call returns exit 144 and nothing after the `pkill` ran
(MICA-447).

**Why:** `-f` matches the full argv, and the pattern is literally in the shell's
argv.

**How to apply:** stop a server you started as a background task with
`TaskStop`; a server started inside your own script, with `kill "$pid"` from
that script. To check a port, `ss -ltn` is enough. If you must pattern-kill, use
a bracket trick (`pkill -f "[v]ite preview --port 4394"`) so the pattern does
not match itself.

A measuring script that ends on `wait` for a preview it just killed exits 143
even when every run succeeded — read the per-run exit lines, not the task's.
