# The Bash guard reads a regex `|` as a pipe

`.claude/hooks/block-dangerous-bash.sh` refuses any command where a gate
(`vitest`, `pnpm typecheck`, a lint) shares a line with a `|` — including a `|`
_inside a quoted grep pattern_ like `grep -E "Tests|FAIL" log`, and a
`cat files | wc -l` elsewhere in the same call. The whole batch is dropped, gate
included.

**How to apply:** after `gate > <scratchpad>/<callsign>-<gate>.log 2>&1; rc=$?`,
filter the log with repeated `-e` flags (`grep -e "Test Files" -e "FAIL" log`),
never an alternation, and keep any real pipeline in a separate Bash call from
the gate. Found on MICA-337.
