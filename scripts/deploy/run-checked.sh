#!/bin/sh

# SPDX-FileCopyrightText: 2026 quissicutdeus
#
# SPDX-License-Identifier: AGPL-3.0-or-later

# Run a command that reaches one of hoth's root wrappers over SSH, then hold what it printed
# to the checked-out copy of that wrapper:
#
#   run-checked.sh <wrapper> <command> [args...]
#
# This is `<command> | tee out`, then check-wrapper-identity.sh on `out`, with the one thing
# a workflow step gets wrong by hand done once: a pipe reports the LAST command's status, so
# `ssh ... | tee log` is green when ssh is red. Here the command's own status is kept, the
# identity check runs whether or not the command succeeded, and the step fails if either
# did. stdin goes to the command untouched (the release zip is piped in that way), and
# stdout and stderr both come out live, so the CI log reads as it always did.
#
# Exit: the command's status when it failed; otherwise the check's. A pass needs both.
set -eu

here=$(cd "$(dirname "$0")" && pwd)

if [ $# -lt 2 ]; then
    echo "usage: $0 <wrapper file name> <command> [args...]" >&2
    exit 2
fi
wrapper=$1
shift

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# The status goes through a file because POSIX sh has no PIPESTATUS. `|| rc=$?` so that `set
# -e` does not end the group before the status is written down.
{
    rc=0
    "$@" 2>&1 || rc=$?
    echo "$rc" >"$tmp/rc"
} | tee "$tmp/out"

# No status file means the group was killed before it could write one: a failure, not a pass.
rc=255
if [ -s "$tmp/rc" ]; then
    rc=$(cat "$tmp/rc")
fi

check=0
sh "$here/check-wrapper-identity.sh" "$wrapper" "$tmp/out" || check=$?

if [ "$rc" -ne 0 ]; then
    echo "run-checked: \`$1\` exited $rc, so this step fails." >&2
    if [ "$check" -ne 0 ]; then
        echo "run-checked: the identity check above also failed. If the run died before it reached the wrapper, a missing line is a consequence of that and not a second fault; read the run's own error first." >&2
    fi
    exit "$rc"
fi
exit "$check"
