#!/bin/sh

# SPDX-FileCopyrightText: 2026 quissicutdeus
#
# SPDX-License-Identifier: AGPL-3.0-or-later

# Did hoth run the copy of a root wrapper that this checkout holds?
#
#   check-wrapper-identity.sh <wrapper> [<output file> | -]
#
# <wrapper> is a file name in this directory (mica-smoke-release.sh, ...). The output is
# what the SSH session printed, a file or stdin. Each root wrapper prints, before it does
# anything, one line:
#
#   mica-wrapper: <name> sha256 <hex of the wrapper's own bytes>
#
# This script hashes the checked-out copy of <wrapper> and holds the session's output to
# that. It fails -- never passes -- when
#
#   - no such line is there. That is a wrapper too old to print one, which is the exact
#     staleness this exists to catch, and also a run that died before the wrapper started;
#   - any such line carries a different hash, or is not a hash at all; or
#   - the checked-out wrapper cannot be read or hashed.
#
# Why: the wrappers are root-owned in /usr/local/sbin and installed by hand, because a
# deploy account that could rewrite what it runs as root would not be unprivileged. So when
# the repo's copy changes and nobody reinstalls it, hoth runs the old one and nothing
# notices. On 2026-10-06 (MICA-306) it was noticed only because the new scenario happened to
# fail loudly. Nothing here gives CI or gphone a way to write the wrapper; the fix is always
# a person running the `sudo install` this script prints.
#
# Only lines that BEGIN with the marker count. A forwarded FXServer console prefixes its
# lines, so a resource that prints a look-alike cannot pose as the wrapper, and a stray
# line in the middle of other output is still found.
#
# Exit: 0 matches, 1 stale or missing, 2 could not run at all (usage, unreadable wrapper).
# Every non-zero exit is a failure; none of them is a skip.
set -eu

here=$(cd "$(dirname "$0")" && pwd)

usage() {
    echo "usage: $0 <wrapper file name> [<ssh output file> | -]" >&2
    exit 2
}

[ $# -ge 1 ] && [ $# -le 2 ] || usage
name=$1
input=${2:--}

# A bare file name in this directory: nothing here should be steered to hash, or print an
# install command for, some other path.
case "$name" in
    */* | '' | . | .. | -*) usage ;;
esac
wrapper="$here/$name"
if [ ! -f "$wrapper" ] || [ ! -r "$wrapper" ]; then
    echo "wrapper identity: cannot read $wrapper, so there is nothing to compare hoth's copy with" >&2
    exit 2
fi

if command -v sha256sum >/dev/null 2>&1; then
    expected=$(sha256sum -- "$wrapper" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
    expected=$(shasum -a 256 -- "$wrapper" | cut -d' ' -f1)
else
    echo "wrapper identity: neither sha256sum nor shasum is installed, so $name cannot be hashed" >&2
    exit 2
fi
case "$expected" in
    *[!0-9a-f]* | '')
        echo "wrapper identity: hashing $wrapper gave '$expected', not a sha256" >&2
        exit 2
        ;;
esac
if [ "${#expected}" -ne 64 ]; then
    echo "wrapper identity: hashing $wrapper gave '$expected', not a sha256" >&2
    exit 2
fi

if [ "$input" != - ]; then
    [ -r "$input" ] || {
        echo "wrapper identity: cannot read the SSH output at $input" >&2
        exit 2
    }
    exec <"$input"
fi

cr=$(printf "\r")
marker="mica-wrapper: $name sha256 "
seen=
count=0
bad=0
# `|| [ -n "$line" ]` so a last line with no newline is still read.
while IFS= read -r line || [ -n "$line" ]; do
    line=${line%"$cr"}
    case "$line" in
        "$marker"*) ;;
        *) continue ;;
    esac
    value=${line#"$marker"}
    count=$((count + 1))
    ok=1
    case "$value" in
        *[!0-9a-f]* | '') ok=0 ;;
    esac
    [ "${#value}" -eq 64 ] || ok=0
    if [ "$ok" -eq 1 ] && [ "$value" = "$expected" ]; then
        :
    else
        bad=$((bad + 1))
    fi
    seen="$seen
    $value"
done

if [ "$count" -gt 0 ] && [ "$bad" -eq 0 ]; then
    echo "wrapper identity: hoth's $name matches this checkout (sha256 $expected)"
    exit 0
fi

if [ "$count" -eq 0 ]; then
    reported="no \"${marker}<hex>\" line in the SSH output (a wrapper too old to print one is reported this way, and so is a run that ended before the wrapper started)"
else
    reported="$count identity line(s), $bad of them not this checkout's:$seen"
fi

cat >&2 <<EOF
hoth's \`$name\` is stale or missing: reinstall it.
  expected sha256 (scripts/deploy/$name in this checkout): $expected
  hoth reported:                                          $reported
Reinstall it on hoth, from a checkout of this commit:
  sudo install -m 700 -o root -g root scripts/deploy/$name /usr/local/sbin/
EOF
# One line for the run's annotations, so it is on the run page and not only in the log.
if [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "::error title=Root wrapper on hoth is stale::hoth's \`$name\` is stale or missing: reinstall it with: sudo install -m 700 -o root -g root scripts/deploy/$name /usr/local/sbin/ (expected sha256 $expected)"
fi
exit 1
