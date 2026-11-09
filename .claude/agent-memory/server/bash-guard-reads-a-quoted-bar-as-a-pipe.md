# The bash guard reads a quoted `|` as a pipe

`.claude/hooks/block-dangerous-bash.sh` refuses any command where a gate's
output is piped, because then `$?` belongs to the filter. It finds pipes in the
raw text, so a `|` inside a quoted argument counts too:

```sh
pnpm exec vitest run x.test.ts -t 'pinned decision|raw mica handler' > log 2>&1
```

That is refused as "a checker is piped into another command", although nothing
is piped. Every other command in the same tool call is refused with it.

MICA-463 lost two batches to it while filtering a sweep's describes with a regex
alternation.

So: never put `|` in a `-t` pattern. Run the whole file to a log and read the
log, or run one `-t` per describe. The same goes for `grep -E 'a|b'` placed
after a gate in the same command. Run the grep in its own tool call, after the
gate has finished.
