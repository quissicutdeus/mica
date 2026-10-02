#!/bin/sh
# PreToolUse guard for the Bash tool.
#
# AGENTS.md §2.1 lists six things that need the user's explicit confirmation
# before they happen: a force-push, moving main, changing branch protection or
# repository settings, --no-verify, and a hard reset over uncommitted work. That
# list only works if it is actually enforced rather than just written down --
# this blocks those specific shapes at the tool boundary instead of relying on
# every agent remembering to ask.
#
# Reads the hook's stdin JSON (the tool_input.command and cwd fields), checks it
# against each guarded shape, and exits 2 with a reason on stderr on a match.
# Anything else passes through untouched. Exit 2 is what actually blocks the
# tool call and returns stderr to the calling agent; exit 1 would not.
#
# The hard reset is the one shape that needs the filesystem, not just the text:
# it is only dangerous when the tree it acts on has something uncommitted, so
# the guard asks git. See the section below the push and gh checks.

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

# One node call yields both fields: the working directory on the first line, then
# "=" and the command. The "=" is what keeps the split safe when the command is
# empty -- $(...) strips trailing newlines, and without a marker an empty command
# would leave no newline to split on and the cwd would be read back as the
# command. A cwd that is absent, not a string, or holds a line break is emitted
# as empty, which the hard-reset check treats as "tree unknown" and refuses.
if ! parsed=$(node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let j;
  try {
    j = JSON.parse(s);
  } catch {
    process.exit(1);
  }
  const cmd = String((j && j.tool_input && j.tool_input.command) || "");
  let cwd = j && typeof j.cwd === "string" ? j.cwd : "";
  if (/[\r\n]/.test(cwd)) {
    cwd = "";
  }
  process.stdout.write(cwd + "\n=" + cmd);
});
'); then
    printf 'blocked: the Bash guard could not parse its input as JSON.\n' >&2
    printf 'this guard fails closed on purpose -- it will not allow a command it was unable to read.\n' >&2
    exit 2
fi

nl='
'
cwd=${parsed%%"$nl"*}
cmd=${parsed#*"$nl="}

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
# A hard reset over uncommitted work.
#
# AGENTS.md §2.1 says to stop and ask before one, and for a long time nothing
# checked. It matters most in the shared main checkout: every lane there edits
# the same working tree, so one lane's hard reset erases every sibling's unsaved
# work with no way back. A lane in its own worktree (.claude/worktrees/...) is
# the opposite case -- it is told to hard-reset onto its brief's tip, on a tree
# nobody else touches, so that stays free.
#
# Unlike the shapes above, this one is only dangerous depending on the tree, so
# the guard asks git rather than reading text: it blocks a hard reset when the
# tree it acts on has anything in `git status --porcelain` (untracked included)
# and that tree's toplevel is not under /.claude/worktrees/. A clean tree passes.
#
# "The tree it acts on" is the hook input's cwd, moved by any `git -C <dir>` in
# the command. Where that cannot be known with confidence the guard refuses
# rather than guesses: no cwd in the input, a `cd` earlier in the command, a -C
# path that is a variable, a glob or holds a space, GIT_DIR / --git-dir /
# --work-tree, or git itself failing on the directory. A reset it cannot place is
# a reset it cannot call safe.
#
# What it does not see: a reset reached through a git alias or a script, a
# substitution inside the git invocation that itself holds a ; & or | (the
# segment is cut there), and other ways to discard work (`checkout -f`, `clean`,
# `restore`). Those are not in AGENTS.md §2.1's list. The text match is flat,
# like the rest of this file, so prose in a heredoc that starts a line with
# `git reset --hard` is read as the command -- write prose with the Write tool,
# as the pipe rule already asks.

# Sets $w to the word $1 with any command-substitution, subshell or brace-group
# wrapper taken off it -- `(git`, `$(git`, `--hard)`, `}` -- so those read as the
# word inside. Parentheses are not segment separators for exactly this reason:
# splitting on them cut a `-C $(pwd)` in half, and the reset behind it was then
# nowhere to be found.
bare() {
    w=$1
    while :; do
        case $w in
            \$\(*) w=${w#??} ;;
            '('* | '{'* | '`'*) w=${w#?} ;;
            *) break ;;
        esac
    done
    while :; do
        case $w in
            *')' | *'}' | *'`') w=${w%?} ;;
            *) break ;;
        esac
    done
}

# Returns 0 when the segment, read as plain words, has `reset` followed by a
# spelling of --hard. The fallback for a segment whose words did not line up.
reset_somewhere() {
    seen_reset=
    set -f
    # shellcheck disable=SC2086
    set -- $stripped
    set +f
    for word in "$@"; do
        case $word in
            reset)
                seen_reset=1
                ;;
            --h | --ha | --har | --hard)
                [ -z "$seen_reset" ] || return 0
                ;;
        esac
    done
    return 1
}

# Reads one command segment (a simple command, split from its neighbours on
# ; & | and newlines). Returns 0 when it is a `git [options] reset ... --hard`,
# leaving the directory that reset acts on in $target and anything it could not
# resolve in $seg_unsure; returns 1 for everything else.
#
# Quotes are dropped before the segment is split into words. That is crude, and
# deliberately so: it is what lets `sh -c 'git reset --hard'` read as a reset,
# and what keeps `git commit -m "undo a reset --hard"` from reading as one,
# because the subcommand is then `commit`. The one thing it would hide is a
# quoted -C path with a space in it, so that is checked first on the raw text.
segment_is_hard_reset() {
    seg_unsure=
    q="[\"']"
    nq="[^\"']"
    if printf '%s\n' "$1" | grep -qE -- "-C[[:space:]]+($q$q|$q$nq*[[:space:]]$nq*$q)"; then
        seg_unsure='a quoted -C path with a space in it, or an empty one, cannot be resolved'
    fi

    stripped=$(printf '%s' "$1" | tr -d '\047\042')
    set -f
    # shellcheck disable=SC2086
    set -- $stripped
    set +f

    # Find the git word. Anything that only prints or searches text is inert,
    # so `grep 'git reset --hard' docs/` is not a reset -- unless the segment
    # holds a substitution, since `echo $(git reset --hard)` runs it. Anything
    # unrecognised in front of git (sudo, xargs, sh -c, env) is treated as
    # running it.
    while [ $# -gt 0 ]; do
        bare "$1"
        case $w in
            echo | printf | grep | egrep | fgrep | rg | cat | head | tail | less | man | wc | sed | awk | diff)
                case $stripped in
                    *\$\(* | *'`'*) ;;
                    *) return 1 ;;
                esac
                ;;
            cd | pushd | popd)
                moved=1
                ;;
            GIT_DIR=* | GIT_WORK_TREE=*)
                unsure='GIT_DIR or GIT_WORK_TREE points git somewhere other than the working directory'
                ;;
            git | */git)
                break
                ;;
        esac
        shift
    done
    [ $# -gt 0 ] || return 1
    shift

    # git's own options come before the subcommand; only -C moves the tree.
    target=$cwd
    while [ $# -gt 0 ]; do
        case $1 in
            -C)
                [ $# -ge 2 ] || break
                case $2 in
                    *'$'* | *'`'* | '~'* | *'*'* | *'?'* | *'['* | *'{'*)
                        seg_unsure="the -C path '$2' is a variable, a substitution, a glob or a tilde, so it cannot be resolved"
                        ;;
                    /*) target=$2 ;;
                    *) target=$target/$2 ;;
                esac
                shift 2
                ;;
            -c | --config-env | --namespace | --super-prefix | --attr-source)
                [ $# -ge 2 ] || break
                shift 2
                ;;
            --git-dir | --git-dir=* | --work-tree | --work-tree=* | --bare)
                seg_unsure='--git-dir, --work-tree and --bare point git somewhere other than the working directory'
                shift
                ;;
            -*)
                shift
                ;;
            *)
                break
                ;;
        esac
    done
    subcommand=
    if [ $# -gt 0 ]; then
        bare "$1"
        subcommand=$w
    fi
    if [ "$subcommand" != reset ]; then
        # Not a reset, as far as the words line up. But an empty -C path or one
        # with a space in it shifts every word after it, so the subcommand read
        # here can be a fragment of the path. Once something in the segment is
        # already known to be unresolvable, look for a reset anywhere in it
        # rather than conclude there is none.
        [ -n "$seg_unsure" ] && reset_somewhere
        return
    fi
    shift

    # git accepts any unambiguous prefix of a long option, and --h is one: it
    # resets hard (checked against git 2.56), so every prefix has to count.
    while [ $# -gt 0 ]; do
        bare "$1"
        case $w in
            --)
                return 1
                ;;
            --h | --ha | --har | --hard)
                return 0
                ;;
        esac
        shift
    done
    return 1
}

check_hard_reset() {
    case "$cmd" in
        *reset*--h*) ;;
        *) return 0 ;;
    esac

    moved=
    unsure=
    # Backslash-newline is a continuation, so those lines are joined first;
    # without that, `git reset \` then `--hard` on the next line would read as
    # two commands. Then each ; & and | becomes a line break. Parentheses and
    # backticks are left inside their words, so a substitution stays whole.
    segments=$(printf '%s\n' "$cmd" | awk '
        {
            line = line $0
            if (sub(/\\$/, "", line)) {
                line = line " "
                next
            }
            gsub(/[;&|]/, "\n", line)
            print line
            line = ""
        }
        END { if (line != "") print line }
    ')
    if [ -z "$segments" ]; then
        block "a hard reset was named but the guard could not split the command to find out which tree it acts on"
    fi

    # The loop reads a here-document, not a pipe: a pipe would run it in a
    # subshell, where block's `exit 2` would end only the subshell and the
    # command would sail through.
    while IFS= read -r seg; do
        segment_is_hard_reset "$seg" || continue

        if [ -n "$moved" ]; then
            block "a hard reset after a cd/pushd/popd in the same command -- the tree it acts on cannot be known; run it as git -C <dir> reset ... instead"
        fi
        if [ -n "$unsure" ]; then
            block "a hard reset whose tree cannot be determined: $unsure"
        fi
        if [ -n "$seg_unsure" ]; then
            block "a hard reset whose tree cannot be determined: $seg_unsure"
        fi
        if [ -z "$cwd" ]; then
            block "a hard reset, but the hook input carried no cwd, so the tree it acts on cannot be known"
        fi
        if ! top=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null) || [ -z "$top" ]; then
            block "a hard reset in '$target', which git cannot resolve to a working tree (missing directory, not a repository, or a bare one)"
        fi
        case "$top" in
            */.claude/worktrees/*)
                continue
                ;;
        esac
        # --no-optional-locks: a status refreshes the index, and doing that under
        # a sibling lane's `git add` makes theirs fail on index.lock.
        # --untracked-files=normal: a user's status.showUntrackedFiles=no must
        # not be able to hide new files from this check.
        if ! changes=$(git --no-optional-locks -C "$top" status --porcelain --untracked-files=normal 2>/dev/null); then
            block "a hard reset in '$top', whose state git status could not report"
        fi
        if [ -n "$changes" ]; then
            block "a hard reset over uncommitted changes in $top -- in the shared checkout it erases every sibling lane's unsaved work; a lane's own .claude/worktrees/ tree is exempt"
        fi
    done <<EOF
$segments
EOF
}

check_hard_reset

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
    printf 'run it as:  <gate> > <scratchpad>/<callsign>-<gate>.log 2>&1; rc=$?; echo "exit=$rc"; tail -20 <scratchpad>/<callsign>-<gate>.log\n' >&2
    printf 'that keeps the real exit code and the whole log. (zsh has no $PIPESTATUS; the array is ${pipestatus[1]}.)\n' >&2
    printf '<scratchpad> is the session scratchpad directory and <callsign> is yours: every lane shares that directory, and a bare or /tmp log is overwritten by a sibling mid-run.\n' >&2
    exit 2
}

case "$cmd" in
    *PIPESTATUS*)
        pipe_block "\$PIPESTATUS is empty in zsh, so this check cannot fail"
        ;;
esac

# The pipe has to be attached to the gate, and the gate has to be the command
# being run -- not merely present somewhere in the same command.
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
#
# The same cry of wolf came back through the gate word itself, which was matched
# anywhere after whitespace. `pgrep -fa playwright | head`, `ps aux | grep
# vitest | wc -l` and `grep -rn tsc docs | head` look for a checker, or for its
# name, and run none -- and were refused like the real thing. A word in argument
# position is not the thing being run, so each regex now opens with command
# position: the start of a line, or right after one of ; & | ( ` or { -- which
# is also what `&&`, `||`, `$(`, a pipeline stage and a brace group look like.
#
# Between that and the gate may stand only what leaves the gate as the command
# being run: `VAR=value` assignments, if/then/do/else/while/until/!, a launcher
# (time, env, nice, xargs, npx, `pnpm exec`, `pnpm --filter x exec`, `sh -c '`
# and so on, with their options) and a path (`./node_modules/.bin/tsc`). For the
# pnpm family the gate is the script name itself -- `pnpm test`, `pnpm run
# test`, `pnpm --filter web test`, and the npm and yarn spellings.
#
# That gives up, on purpose, only a gate that is genuinely an argument to
# something this list does not know is a launcher (`ssh host tsc | tail`,
# `docker run img vitest | tail`, `node node_modules/vitest/vitest.mjs | tail`).
# The text is still read flat, as everywhere in this file, so a quoted
# 'a;tsc | b' is read as a command.
#
# The check must not be able to fail open itself. A regex grep cannot compile
# makes grep exit 2, and an `if` reads that exactly like "no match" -- the whole
# pipe rule would go quiet while looking installed. So grep's status is read
# here, and anything but 0 or 1 refuses.

dirp='([-A-Za-z0-9_./~@+{}$]*/)?'
cp='(^|[;&|(`{])[[:space:]]*'
tail='([^;|&]|&[^&])*\|[^|]'

assign="[A-Za-z_][A-Za-z0-9_]*=(\"[^\"]*\"|'[^']*'|[^[:space:]\"'])*[[:space:]]+"
keyword='(if|then|do|else|elif|while|until|!)[[:space:]]+'
launcher="${dirp}(exec|time|env|nice|nohup|command|timeout|stdbuf|xargs|corepack|npx|pnpx|bunx)[[:space:]]+"'((-[^[:space:]]*|[0-9][0-9a-z.]*|\{\})[[:space:]]+)*'
evalq="eval[[:space:]]+[\"']?"
shellc="${dirp}(sh|bash|zsh|dash|ash|ksh)[[:space:]]+(-[A-Za-z]+[[:space:]]+)*-[A-Za-z]*c[[:space:]]+[\"']"

# What may follow `pnpm`, `npm` or `yarn` before the subcommand: an option, or
# one of the options that takes a value (a directory, a package filter).
pmopts='((--filter|-F|--dir|-C|--filter-prod|--workspace|-w|--prefix)[[:space:]]+[^[:space:]]+[[:space:]]+|-{1,2}[A-Za-z][^[:space:]]*[[:space:]]+)*(workspace[[:space:]]+[^[:space:]]+[[:space:]]+)?'
pmrun="${dirp}(p?npm|yarn)[[:space:]]+${pmopts}"'((exec|dlx|x|run|run-script)[[:space:]]+)?(--[[:space:]]+)?'

prefix="($assign|$keyword|$launcher|$evalq|$shellc)*"
prefix_pm="($assign|$keyword|$launcher|$evalq|$shellc|$pmrun)*"

pm_gate="${dirp}(p?npm|yarn)[[:space:]]+${pmopts}"'((run|run-script|dlx)[[:space:]]+)?(--[[:space:]]+)?(verify|test|typecheck|lint|build|check|format|deadcode|docs)'
script_gate="${dirp}node[[:space:]]+"'(-[^[:space:]]*[[:space:]]+)*(\./)?scripts/(verify|check-[a-z-]+|lint-[a-z-]+)\.js'
checker_gate="${dirp}(vitest|playwright|tsc|svelte-check|eslint|knip|prettier|shellcheck|hadolint)"

# Returns 0 when $cmd runs $2 as a command (after any of the prefix words in $1)
# and pipes it; 1 when it does not; and refuses when grep itself failed.
pipe_check() {
    printf '%s\n' "$cmd" | grep -qE -- "${cp}${1}${2}${tail}"
    grep_rc=$?
    case $grep_rc in
        0) return 0 ;;
        1) return 1 ;;
    esac
    printf 'blocked: the Bash guard could not run its pipe check (grep exited %s).\n' "$grep_rc" >&2
    printf 'this guard fails closed on purpose -- a check that cannot run must refuse, not read as a pass.\n' >&2
    exit 2
}

if pipe_check "$prefix" "$pm_gate"; then
    pipe_block "a pnpm gate is piped into another command"
fi

if pipe_check "$prefix" "$script_gate"; then
    pipe_block "a verification script is piped into another command"
fi

if pipe_check "$prefix_pm" "$checker_gate"; then
    pipe_block "a checker is piped into another command"
fi

exit 0
