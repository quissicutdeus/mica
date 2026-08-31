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

cmd=$(jq -r '.tool_input.command // empty')

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

exit 0
