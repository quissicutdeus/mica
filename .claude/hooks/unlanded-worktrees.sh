#!/bin/sh
#
# SPDX-FileCopyrightText: 2026 quissicutdeus
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# SessionStart hook: name every lane worktree under .claude/worktrees/ that
# holds work not on dev.
#
# A lead session once died mid-integration and three finished lane commits sat
# in .claude/worktrees/agent-* with nothing to say so; a later session found
# them by accident. SessionStart stdout reaches the session, so this prints
# what is stranded, and nothing when nothing is.
#
# It fails loud: when it cannot check, it says so on stdout ("could not
# check:") and still exits 0 so the session starts. Silence would read as
# "nothing stranded". dev is spelled refs/heads/dev throughout, because a
# tracked dev/ directory makes the bare name ambiguous here.

fail() {
    printf 'unlanded-worktrees: could not check: %s\n' "$1"
    exit 0
}

[ -n "${CLAUDE_PROJECT_DIR:-}" ] || fail 'CLAUDE_PROJECT_DIR is not set'
root=$(cd "$CLAUDE_PROJECT_DIR" 2>/dev/null && pwd -P) ||
    fail "CLAUDE_PROJECT_DIR ($CLAUDE_PROJECT_DIR) is not a directory"
git -C "$root" rev-parse --git-dir >/dev/null 2>&1 ||
    fail "$root is not a git repository"
git -C "$root" rev-parse --verify --quiet refs/heads/dev >/dev/null ||
    fail 'refs/heads/dev does not exist'
list=$(git -C "$root" worktree list --porcelain 2>&1) ||
    fail "git worktree list failed: $list"

lanes="$root/.claude/worktrees/"
out=''
path=''
head=''
branch=''
prunable=''

# Judge the worktree collected so far, then clear it for the next block.
flush() {
    case "$path" in
        "$lanes"*)
            if [ -n "$prunable" ] && [ ! -d "$path" ]; then
                where='directory gone'
            else
                where=''
            fi
            if [ -n "$head" ]; then
                ahead=$(git -C "$root" rev-list --count "$head" ^refs/heads/dev 2>&1) ||
                    fail "git rev-list failed for $path: $ahead"
            else
                ahead=0
            fi
            if [ -n "$where" ]; then
                dirty='?'
            else
                dirty=$(git -C "$path" status --porcelain 2>&1) ||
                    fail "git status failed for $path: $dirty"
                if [ -n "$dirty" ]; then
                    dirty=$(printf '%s\n' "$dirty" | wc -l | tr -d ' ')
                else
                    dirty=0
                fi
            fi
            if [ -n "$where" ] || [ "$ahead" != 0 ] || [ "$dirty" != 0 ]; then
                label=${branch:-detached}
                note=''
                [ -n "$where" ] && note=" (prunable: $where)"
                out="$out
  ${path#"$root"/}  $label  $ahead commits not on dev, $dirty uncommitted paths$note"
            fi
            ;;
    esac
    path=''
    head=''
    branch=''
    prunable=''
}

while IFS= read -r line; do
    case "$line" in
        'worktree '*)
            flush
            path=${line#worktree }
            ;;
        'HEAD '*) head=${line#HEAD } ;;
        'branch '*) branch=${line#branch refs/heads/} ;;
        prunable*) prunable=1 ;;
    esac
done <<EOF
$list
EOF
flush

if [ -n "$out" ]; then
    printf 'unlanded-worktrees: these lane worktrees hold work not on dev. Land or discard them before new work (lead-protocol, "If the lead'"'"'s session dies"):%s\n' "$out"
fi
exit 0
