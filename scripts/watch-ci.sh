#!/bin/sh

# SPDX-FileCopyrightText: 2026 quissicutdeus
#
# SPDX-License-Identifier: AGPL-3.0-or-later

# Watch every GitHub Actions run for one pushed commit until they have all finished, and
# exit non-zero unless every one of them concluded in success:
#
#   scripts/watch-ci.sh [-R owner/name] <full-40-char-sha> [out-file]
#
# Runs register late: Deploy follows Verify through `workflow_run`, so this keeps polling
# until everything seen has completed AND nothing new has appeared for a quiet period.
# One line per run is printed (and written to out-file, if given):
#
#   <workflow>  <status>  <conclusion>  <run id>  [superseded]
#
# A workflow can run more than once on a sha (a re-run, a later dispatch). Per workflow name
# the NEWEST run (highest run id) decides the verdict; an older run of the same name is still
# printed, marked `superseded` in a fifth column, but no longer counts. It is never dropped:
# a hidden failure reads as a pass. A failing newest run fails, and a newest run still going
# keeps the watch pending.
#
# Exit status: 0 every run succeeded (a workflow-level `skipped` is reported but allowed);
# 1 a run failed, no run ever registered, or the watch ran out of time; 2 bad usage or
# `gh` could not be asked. It never reads silence as a pass: `gh run list --commit` matches
# nothing on a short sha, so a short sha is refused rather than watched for nothing.
#
# GH_CONFIG_DIR is honoured when the caller set it. The repo is `-R`, else the one `gh`
# resolves for the current checkout. Tuning, for tests: WATCH_CI_INTERVAL (seconds between
# polls, default 20), WATCH_CI_QUIET (quiet polls needed, default 6), WATCH_CI_POLLS (poll
# budget, default 180), WATCH_CI_ERRORS (consecutive gh failures tolerated, default 5).

interval=${WATCH_CI_INTERVAL:-20}
quiet_needed=${WATCH_CI_QUIET:-6}
max_polls=${WATCH_CI_POLLS:-180}
max_errors=${WATCH_CI_ERRORS:-5}

repo=
if [ "${1:-}" = "-R" ]; then
    repo=${2:-}
    [ -n "$repo" ] || {
        echo "watch-ci: -R needs owner/name" >&2
        exit 2
    }
    shift 2
fi

sha=${1:-}
out=${2:-}

case $sha in
    '' | *[!0-9a-f]*)
        echo "usage: watch-ci.sh [-R owner/name] <full-40-char-sha> [out-file]" >&2
        echo "watch-ci: '$sha' is not a lowercase 40-hex sha" >&2
        exit 2
        ;;
esac
if [ "${#sha}" -ne 40 ]; then
    echo "watch-ci: '$sha' is ${#sha} characters; a full 40-character sha is required." >&2
    echo "watch-ci: gh matches --commit on the full sha only, so a short one would watch nothing." >&2
    exit 2
fi

command -v gh >/dev/null 2>&1 || {
    echo "watch-ci: gh is not installed" >&2
    exit 2
}

if [ -z "$repo" ]; then
    repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || repo=
    [ -n "$repo" ] || {
        echo "watch-ci: could not work out the repo from gh; pass -R owner/name" >&2
        exit 2
    }
fi

tab=$(printf '\t')
seen=' '
quiet=0
errors=0
poll=0
runs=''

while [ "$poll" -lt "$max_polls" ]; do
    poll=$((poll + 1))
    if ! runs=$(gh run list -R "$repo" --commit "$sha" --limit 100 \
        --json databaseId,status,conclusion,workflowName \
        --jq '.[] | [.databaseId, .status, (.conclusion // "none"), .workflowName] | join("\t")'); then
        errors=$((errors + 1))
        echo "watch-ci: gh run list failed ($errors/$max_errors)" >&2
        if [ "$errors" -ge "$max_errors" ]; then
            echo "watch-ci: giving up; this is NOT a pass, the runs were never read" >&2
            exit 2
        fi
        sleep "$interval"
        continue
    fi
    errors=0

    new=0
    pending=0
    while IFS="$tab" read -r id status _ _; do
        [ -n "$id" ] || continue
        case $seen in
            *" $id "*) ;;
            *)
                seen="$seen$id "
                new=1
                ;;
        esac
        [ "$status" = completed ] || pending=1
    done <<EOF
$runs
EOF

    if [ "$new" = 1 ] || [ "$pending" = 1 ]; then
        quiet=0
    elif [ "$seen" != ' ' ]; then
        quiet=$((quiet + 1))
        [ "$quiet" -ge "$quiet_needed" ] && break
    fi
    sleep "$interval"
done

if [ "$seen" = ' ' ]; then
    echo "watch-ci: NO RUNS registered for $sha in $repo after $poll polls" >&2
    [ -z "$out" ] || echo "NO RUNS registered for $sha" >"$out"
    exit 1
fi

# The verdict comes from the conclusions of the last read, never from a watcher's status.
report=$(printf '%s\n' "$runs" | awk -F '\t' -v OFS='\t' '
    $1 != "" { n++; id[n] = $1; st[n] = $2; co[n] = $3; wf[n] = $4
        if (!($4 in top) || $1 + 0 > top[$4] + 0) top[$4] = $1 }
    END { for (i = 1; i <= n; i++)
        print wf[i], st[i], co[i], id[i], (id[i] + 0 < top[wf[i]] + 0 ? "superseded" : "") }')
printf '%s\n' "$report"
[ -z "$out" ] || printf '%s\n' "$report" >"$out"

verdict=0
if [ "$quiet" -lt "$quiet_needed" ]; then
    echo "watch-ci: ran out of polls ($max_polls) before the runs settled" >&2
    verdict=1
fi
while IFS="$tab" read -r _ status conclusion _ superseded; do
    [ -n "$status" ] || continue
    [ "$superseded" != superseded ] || continue
    if [ "$status" != completed ]; then
        echo "watch-ci: a run is still $status" >&2
        verdict=1
    elif [ "$conclusion" != success ] && [ "$conclusion" != skipped ]; then
        verdict=1
    fi
done <<EOF
$report
EOF
[ "$verdict" = 0 ] || echo "watch-ci: FAILED for $sha" >&2
exit "$verdict"
