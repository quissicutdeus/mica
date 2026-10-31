#!/bin/sh

# SPDX-FileCopyrightText: 2026 quissicutdeus
#
# SPDX-License-Identifier: AGPL-3.0-or-later

# Run a command that reaches hoth's smoke wrapper over SSH, then hold what it printed to the
# lines the workflow expects of a passing run:
#
#   run-checked.sh <command> [args...]
#
# This is `<command> | tee out`, with the one thing a workflow step gets wrong by hand done
# once: a pipe reports the LAST command's status, so `ssh ... | tee log` is green when ssh is
# red. Here the command's own status is kept, and the step fails if it failed. stdin goes to the
# command untouched (the release zip is piped in that way), and stdout and stderr both come out
# live, so the CI log reads as it always did.
#
# RUN_CHECKED_REQUIRE (MICA-304): lines, one per line of the variable, that the session's output
# has to contain. The wrapper's exit status says every run it made passed; this says it made the
# runs the workflow expects. A wrapper edited to leave a run out exits 0, and without this the
# step would be green for a run that did not happen. Fixed strings, matched anywhere in a line.
#
# Exit: the command's status when it failed; otherwise 1 when a required line is missing, else 0.
set -eu

if [ $# -lt 1 ]; then
    echo "usage: $0 <command> [args...]" >&2
    exit 2
fi

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

if [ "$rc" -ne 0 ]; then
    echo "run-checked: \`$1\` exited $rc, so this step fails." >&2
    exit "$rc"
fi

missing=0
if [ -n "${RUN_CHECKED_REQUIRE:-}" ]; then
    while IFS= read -r want; do
        [ -n "$want" ] || continue
        if ! grep -qF -- "$want" "$tmp/out"; then
            echo "run-checked: the output never said \`$want\`, so this step fails although \`$1\` exited 0: a run the workflow expects did not happen." >&2
            missing=1
        fi
    done <<EOF2
$RUN_CHECKED_REQUIRE
EOF2
fi
exit "$missing"
