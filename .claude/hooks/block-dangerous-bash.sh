#!/bin/sh
# PreToolUse guard for the Bash tool.
#
# AGENTS.md §2.1 lists five things that need the user's explicit confirmation
# before they happen: a force-push, moving main, changing branch protection or
# repository settings, and --no-verify. That list only works if it is actually
# enforced rather than just written down -- this blocks those specific shapes
# at the tool boundary instead of relying on every agent remembering to ask.
#
# Reads the hook's stdin JSON (the tool_input.command field), checks it against
# each guarded shape, and exits 2 with a reason on stderr on a match. Anything
# else passes through untouched. Exit 2 is what actually blocks the tool call
# and returns stderr to the calling agent; exit 1 would not.

# Parsed with node, not jq: jq is not installed on these machines, and the
# original `cmd=$(jq -r ...)` therefore returned the empty string on every
# invocation. An empty command matches none of the cases below, so this guard
# exited 0 and allowed everything -- a force-push, a push to main, --no-verify
# -- for its entire existence, while AGENTS.md §2.1 described it as enforced.
# Exactly the failure this repo keeps warning about: silent when it cannot run,
# and therefore read as a pass.
#
# So the parser is now something the repo already requires (Node 26), and the
# two ways this can fail are blocks rather than fall-throughs. A guard that
# cannot read its input must refuse, not wave the call through.
# `server/__tests__/bashGuard.test.ts` runs this file against both shapes so it
# cannot quietly go inert again.

if ! command -v node >/dev/null 2>&1; then
    printf 'blocked: the Bash guard cannot run -- node is not on PATH.\n' >&2
    printf 'this guard fails closed on purpose. install node, or remove the hook from .claude/settings.json deliberately.\n' >&2
    exit 2
fi

if ! cmd=$(node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let j;
  try {
    j = JSON.parse(s);
  } catch {
    process.exit(1);
  }
  process.stdout.write(String((j && j.tool_input && j.tool_input.command) || ""));
});
'); then
    printf 'blocked: the Bash guard could not parse its input as JSON.\n' >&2
    printf 'this guard fails closed on purpose -- it will not allow a command it was unable to read.\n' >&2
    exit 2
fi

block() {
    printf 'blocked by AGENTS.md §2.1: %s\n' "$1" >&2
    printf "this needs the user's explicit confirmation first -- say what you were about to do and why, then wait.\n" >&2
    exit 2
}

case "$cmd" in
    *--no-verify*)
        block "--no-verify bypasses a quality gate"
        ;;
esac

case "$cmd" in
    *push*)
        case "$cmd" in
            *--force* | *' -f '* | *' -f')
                block "a force-push can overwrite upstream history"
                ;;
        esac
        case "$cmd" in
            *'origin main'* | *'upstream main'* | *'HEAD:main'* | *'HEAD:refs/heads/main'* | *:main*)
                block "this push would move main"
                ;;
        esac
        ;;
esac

case "$cmd" in
    *'gh api'*/branches* | *'gh api'*/settings*)
        block "gh api against /branches or /settings changes branch protection or repository settings"
        ;;
esac

# GitHub's actual repo-settings endpoint has no /settings segment -- it's a
# mutating method straight on repos/<owner>/<repo>, with nothing after it
# (repos/<owner>/<repo>/anything-else is a sub-resource, not settings).
case "$cmd" in
    *'gh api'*)
        if echo "$cmd" | grep -qE -- '(^|[[:space:]])(-X|--method)[[:space:]]+(PATCH|PUT|DELETE|patch|put|delete)([[:space:]]|$)' &&
            echo "$cmd" | grep -qE -- '(^|[[:space:]])repos/[^/[:space:]]+/[^/[:space:]]+($|[[:space:]])'; then
            block "gh api PATCH/PUT/DELETE on repos/<owner>/<repo> changes or deletes the repository"
        fi
        ;;
esac

# --------------------------------------------------------------------------
# A gate piped into a filter reports the filter's exit code, not the gate's.
#
# AGENTS.md §9 already says this ("a pipeline like `pnpm test:e2e | tail -5`
# reports `tail`'s exit code, not the suite's"), and saying it was not enough:
# it has been got wrong repeatedly, and a red suite read as green is the worst
# outcome this repo has -- worse than no gate, because it is believed.
#
# Two shapes are refused. A gate piped anywhere, and $PIPESTATUS, which is a
# bashism: this shell is zsh, where the array is $pipestatus and is 1-indexed,
# so ${PIPESTATUS[0]} expands to the empty string and any check built on it
# passes silently no matter what the gate did. That is a check that fails open,
# inside the guard meant to stop checks failing open.
#
# The fix in both cases is the same and is strictly better than the pipe: send
# the output to a file, read $? while it is still the gate's, then read the log
# at leisure. You keep the whole log instead of the last few lines of it.

# The single quotes are deliberate: this message is telling the reader to type
# `$?` and `${pipestatus[1]}`, so those must reach them literally rather than
# being expanded here.
# shellcheck disable=SC2016
pipe_block() {
    printf 'blocked: %s\n' "$1" >&2
    printf 'a gate must not be piped -- $? would belong to the last command in the pipeline, not to the gate.\n' >&2
    printf 'run it as:  <gate> > /tmp/gate.log 2>&1; rc=$?; echo "exit=$rc"; tail -20 /tmp/gate.log\n' >&2
    printf 'that keeps the real exit code and the whole log. (zsh has no $PIPESTATUS; the array is ${pipestatus[1]}.)\n' >&2
    exit 2
}

case "$cmd" in
    *PIPESTATUS*)
        pipe_block "\$PIPESTATUS is empty in zsh, so this check cannot fail"
        ;;
esac

# The pipe has to be attached to the gate, not merely present somewhere in the
# same command.
#
# `grep` tests each line on its own, so a first attempt that asked "is there a
# gate?" and "is there a pipe?" as two separate greps matched any multi-line
# script that named a gate and used a pipe for something unrelated -- including
# the heredoc that writes this file, and any script whose comments mention one.
# A guard that cries wolf on ordinary work gets switched off, which would leave
# the real case uncovered.
#
# So: one regex per family, with `([^;|&]|&[^&])*` in between, which keeps both
# halves inside a single command -- a gate, then nothing that would terminate
# it, then a pipe.
#
# That middle group has to admit a lone `&` while still breaking on `&&`, and
# the reason is `2>&1`. A first version excluded `&` outright and so stopped
# matching the single most common shape there is, `<gate> 2>&1 | tail` -- the
# guard read as working and let through the exact command it exists to catch.
# `&[^&]` consumes the redirect; `&&` matches neither branch and ends the run.
#
# `||` is excluded by the trailing `[^|]`, since it is control flow and the
# left-hand side keeps its own exit status.
if echo "$cmd" | grep -qE '(^|[[:space:]`(])(p?npm|yarn)[[:space:]]+(run[[:space:]]+)?(verify|test|typecheck|lint|build|check|format|deadcode|docs)(:[a-z:-]+)?([^;|&]|&[^&])*\|[^|]'; then
    pipe_block "a pnpm gate is piped into another command"
fi

if echo "$cmd" | grep -qE '(^|[[:space:]`(])(vitest|playwright|tsc|svelte-check|eslint|knip|prettier|shellcheck|hadolint)([^;|&]|&[^&])*\|[^|]'; then
    pipe_block "a checker is piped into another command"
fi

exit 0
