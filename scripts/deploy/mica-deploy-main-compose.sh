#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 quissicutdeus
#
# SPDX-License-Identifier: AGPL-3.0-or-later

# Root-owned deploy wrapper. gphone can only invoke this exact script via sudoers;
# it cannot edit it. Before trusting compose.yaml to define what runs as root, verify
# its content matches this pinned hash -- gphone has write access to that file (git
# needs it) so the file itself is not trustworthy, only this hash is.
#
# The RCON reload lives HERE, not in ~gphone/bin/deploy-main.sh, because the password
# is in /opt/fivem-main/.env -- 0600, owned by mbiddle. gphone cannot read it; root
# can. The old code read it as gphone and got an empty string, and because
# `export VAR=$(...)` returns export's status rather than the command's, it sailed
# straight past `set -e` and sent an RCON packet with a blank password on every
# deploy. The resource was never reloaded. The "no response (timeout)" line it
# printed was the only symptom, and it looked like a network hiccup.
set -euo pipefail

# BEGIN wrapper-common
# This block is the same text in all three root wrappers, and server/__tests__/wrapperCommon.test.ts
# fails when the copies differ. It is repeated rather than sourced because each wrapper is one
# root-owned file installed by hand: a fourth file would be a fourth thing to reinstall, and the
# identity line below would not cover it.
#
# Nothing here prints before the run's last line unless something is wrong or the box is busy, so
# the identity line stays the first output.
#
# 1. No silent exit (MICA-315). `set -e` ends a run at a failing command and says nothing, and on
#    2026-10-06 an integration run's CI log stopped at "smoke: starting mariadb:noble" with exit 1
#    and no reason. So the ERR trap names a failing command (set -E carries it into functions),
#    every deliberate exit goes through die() or prints its own reason, and the EXIT trap ends
#    every run with one status line. Only a failure in the main shell is reported: the shell that
#    ran a failing `$(...)` reports the assignment itself, once.
# 2. One job at a time on hoth. The two deploys and the smoke and integration runs share the box's
#    images, networks and licence key, and a deploy rebuilding an image under a run that is about
#    to start a container from it is how the run above died. They take one lock, on a file only
#    root can write, and hold it to the end of the run, cleanup included.
set -E
wrapper_name=${0##*/}
explained=0
hoth_locked=0
# Set as the last act of a run that got to its end. An exit status of 0 without it is a run that
# was cut short, which is how a signal looks to the EXIT trap: bash runs it with the status of the
# last command, not the signal's, and a trap that believed that would report a killed run as a pass.
completed=0

# Every command below resolves from a known path when this runs as root. The deploy wrappers are
# reached through a sudoers rule tagged SETENV, so a caller may be able to hand over a PATH, and
# hoth's secure_path should stop that but nothing here may depend on it. $EUID is bash's own: it
# is set by the shell and nothing in the environment can change it, which is why every decision
# about who is running is made on it and none on `id -u`, a program found through PATH. A trial
# by an ordinary user keeps the caller's PATH, since that is how its stand-in docker is found.
if ((EUID == 0)); then
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    export PATH
fi

HOTH_LOCK_FILE=/run/mica-hoth.lock
# How long a job waits for the box. A deploy holds it for 1 to 3 minutes and an integration run for
# 5 to 10 (90s for the database, 180s to start and 300s for the suite, at most), and a release
# makes two runs back to back. 1500s outlasts two of the longest, so a job queued behind a run and
# another job still goes, and it is far short of hanging a CI job on a holder that is stuck.
HOTH_LOCK_TIMEOUT=1500
# A trial by an ordinary user may point the lock elsewhere and shorten the wait. Root ignores both:
# a lock is only worth something if its callers cannot choose it.
if [[ $EUID -ne 0 ]]; then
    HOTH_LOCK_FILE=${MICA_HOTH_LOCK:-${TMPDIR:-/tmp}/mica-hoth-$EUID.lock}
    HOTH_LOCK_TIMEOUT=${MICA_HOTH_LOCK_TIMEOUT:-$HOTH_LOCK_TIMEOUT}
fi

die() {
    explained=1
    echo "REFUSED: $*" >&2
    exit 1
}

on_err() {
    local status=$1 line=$2 command=$3
    [[ $BASHPID == "$$" ]] || return 0
    explained=1
    echo "mica-wrapper: $wrapper_name FAILED at line $line: $command (exit status $status)" >&2
}
trap 'on_err "$?" "$LINENO" "$BASH_COMMAND"' ERR

hoth_lock_holder() {
    local holder
    holder=$(head -n 1 -- "$HOTH_LOCK_FILE" 2>/dev/null || true)
    echo "${holder:-an unidentified run (the lock file names no holder)}"
}

# Take the box. $1 is a note for whoever has to wait behind this run.
hoth_lock() {
    local note=${1:-} started=$SECONDS old_umask info owner mode
    # The note comes from the deploy account's environment and lands in other jobs' logs.
    note=${note//[^[:print:]]/?}
    [[ $HOTH_LOCK_TIMEOUT =~ ^[0-9]+$ ]] || die "the lock timeout '$HOTH_LOCK_TIMEOUT' is not a number of seconds"
    command -v flock >/dev/null || die "flock is not installed; hoth's jobs cannot be serialised, so none may run"
    [[ ! -L $HOTH_LOCK_FILE ]] || die "$HOTH_LOCK_FILE is a symlink; it must be a plain file this user owns"
    old_umask=$(umask)
    umask 022
    exec 9>>"$HOTH_LOCK_FILE" || die "cannot open the lock file $HOTH_LOCK_FILE"
    umask "$old_umask"
    # Judged on the open file, not the path, so nothing can be swapped in between. A lock the
    # deploy account could write is one it could fill with a false holder or replace.
    info=$(stat -L -c '%u %a' "/proc/$$/fd/9") || die "cannot stat the lock file $HOTH_LOCK_FILE"
    owner=${info% *}
    mode=${info#* }
    [[ $owner == "$EUID" ]] || die "$HOTH_LOCK_FILE is owned by uid $owner, not by this user; refusing a lock someone else made"
    (((8#$mode & 022) == 0)) || die "$HOTH_LOCK_FILE is writable by group or others (mode $mode); refusing a lock the deploy account could tamper with"
    if ! flock -n 9; then
        echo "mica-wrapper: $wrapper_name is waiting for hoth's lock $HOTH_LOCK_FILE, held by: $(hoth_lock_holder)"
        echo "mica-wrapper: deploys and smoke and integration runs share this box's images, networks and licence key, so they run one at a time; waiting up to ${HOTH_LOCK_TIMEOUT}s"
        flock -w "$HOTH_LOCK_TIMEOUT" 9 ||
            die "gave up after ${HOTH_LOCK_TIMEOUT}s waiting for hoth's lock $HOTH_LOCK_FILE, still held by: $(hoth_lock_holder). Nothing was started. If that run is stuck, find and stop it on hoth."
        echo "mica-wrapper: $wrapper_name got hoth's lock after $((SECONDS - started))s"
    fi
    hoth_locked=1
    printf '%s\n' "$wrapper_name pid $$ ${note:+($note) }since $(date -u +%Y-%m-%dT%H:%M:%SZ)" >|"/proc/$$/fd/9"
}

on_exit() {
    local rc=$?
    set +e
    trap - ERR
    if declare -F wrapper_cleanup >/dev/null; then
        wrapper_cleanup || echo "mica-wrapper: $wrapper_name: cleanup failed; a container, network or directory of this run may be left behind" >&2
    fi
    # Still holding the lock here: the next job starts only after this run has cleaned up.
    if [[ $hoth_locked == 1 ]]; then
        : >|"/proc/$$/fd/9"
    fi
    if ((rc == 0 && completed == 1)); then
        echo "mica-wrapper: $wrapper_name finished ok"
    elif ((rc == 0)); then
        echo "mica-wrapper: $wrapper_name FAILED: the run ended before it finished, so it is not a pass: a signal (the session was cut, or the job was cancelled) or an exit that said 0 too early" >&2
        rc=1
    elif ((rc > 128)); then
        echo "mica-wrapper: $wrapper_name FAILED: exit status $rc, which is signal $((rc - 128)) (the session was cut or the run was killed)" >&2
    elif [[ $explained == 1 ]]; then
        echo "mica-wrapper: $wrapper_name FAILED: exit status $rc; the line above says why" >&2
    else
        echo "mica-wrapper: $wrapper_name FAILED: exit status $rc, and no step named a reason; bash's own message above, if any, is all there is (an unset variable ends a run this way)" >&2
    fi
    exit "$rc"
}
trap on_exit EXIT
# END wrapper-common

# Identity line, first thing, so CI can tell which copy of this script hoth is really running.
# This file is root-owned and installed by hand (scripts/deploy/README.md), which means a change
# to the repo's copy reaches the box only when a person reinstalls it, and nothing says so when
# they do not. scripts/deploy/check-wrapper-identity.sh, called by every CI job that reaches
# this script, compares this hash with the checked-out copy's and fails the job on a difference
# or on no line at all. The name is $0's, and the line precedes every guard below, so a run
# that is refused further down still says what ran. Keep the format: that script parses it.
self_sha=$(sha256sum -- "$0" | cut -d' ' -f1)
echo "mica-wrapper: ${0##*/} sha256 $self_sha"

COMPOSE_FILE="/opt/fivem-main/server-data/vendor/mica/compose.yaml"
# Re-pinned for MICA-234: three new pass-through build args (VITE_MICA_DISABLED_APPS,
# VITE_MICA_DEFAULT_DOCK, VITE_MICA_DEFAULT_CONTACTS), same empty-unless-set form as
# GIT_BRANCH above. Reviewed before re-pinning, which is the whole point of this gate:
# the diff is three added args, and nothing about what runs as root is structurally
# different.
EXPECTED_SHA="7065c501b674ce719c9a9fb12831a3b0a987682d5f3c9c73c3927a33462df88b"
ENV_FILE="/opt/fivem-main/.env"
FIVEM_PORT=30120

# A trial by an ordinary user may point these elsewhere, so server/__tests__/deployWrapper.test.ts
# can run this script against a stand-in docker. Under sudo this runs as root, and root ignores
# all four: the file the hash is checked against, the hash, the password file and the RCON port
# are not something this script's caller chooses.
if [[ $EUID -ne 0 ]]; then
    COMPOSE_FILE=${MICA_DEPLOY_COMPOSE_FILE:-$COMPOSE_FILE}
    EXPECTED_SHA=${MICA_DEPLOY_EXPECTED_SHA:-$EXPECTED_SHA}
    ENV_FILE=${MICA_DEPLOY_ENV_FILE:-$ENV_FILE}
    FIVEM_PORT=${MICA_DEPLOY_RCON_PORT:-$FIVEM_PORT}
fi

# compose.yaml reads these from the environment. deploy-<target>.sh supplies
# them and sudoers env_keeps them across the sudo boundary -- but nothing made
# them REQUIRED, and unset they do not error: compose quietly falls back to the
# defaults baked into compose.yaml, whose container_name is the same string for
# both targets. So running this script bare renames one target's container to
# that default and then collides with it from the other, leaving the live
# container removed and the replacement stuck in Created. Ask how I know.
: "${MICA_PORT:?not set -- invoke ~gphone/bin/deploy-<target>.sh, not this directly}"
: "${GIT_BRANCH:?not set -- invoke ~gphone/bin/deploy-<target>.sh, not this directly}"
: "${GIT_SHA:?not set -- invoke ~gphone/bin/deploy-<target>.sh, not this directly}"
: "${MICA_CALVER:?not set -- invoke ~gphone/bin/deploy-<target>.sh, not this directly}"
: "${MICA_CONTAINER_NAME:?not set -- invoke ~gphone/bin/deploy-<target>.sh, not this directly}"
: "${MICA_IMAGE_TAG:?not set -- invoke ~gphone/bin/deploy-<target>.sh, not this directly}"

# One job at a time on hoth, shared with the other deploy and the smoke and integration runs
# (MICA-315): the stacks share the docker daemon, its image store and the box, and an
# integration run starts its container from the image a deploy is rebuilding. Taken after the
# checks above, which refuse a misuse at once instead of queueing it, and held to the end of the
# run, the RCON reload included. The common block at the top has the rest.
hoth_lock "$GIT_BRANCH@${GIT_SHA:0:12}"

ACTUAL_SHA=$(sha256sum "$COMPOSE_FILE" | cut -d' ' -f1)
if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
    explained=1
    echo "REFUSED: $COMPOSE_FILE does not match the pinned hash." >&2
    echo "expected: $EXPECTED_SHA" >&2
    echo "actual:   $ACTUAL_SHA" >&2
    echo "If this is a legitimate change, update EXPECTED_SHA in this script by hand." >&2
    exit 1
fi

docker compose -p mica-main -f "$COMPOSE_FILE" up -d --build

# Bare assignment guarded by an explicit emptiness check -- never
# `export VAR=$(...)`, which is what hid this failure for two days.
RCON_PASSWORD=$(grep -m1 '^RCON_PASSWORD=' "$ENV_FILE" | cut -d= -f2- || true)
if [[ -z "$RCON_PASSWORD" ]]; then
    die "no RCON_PASSWORD in $ENV_FILE -- micaOS was rebuilt but NOT reloaded"
fi

export RCON_PASSWORD FIVEM_PORT
python3 - <<'PYEOF'
import os, socket, sys

pw = os.environ["RCON_PASSWORD"]
port = int(os.environ["FIVEM_PORT"])
# The resource is `mica` (MICA-274). This line said `micaOS` from the rename until
# 2026-10-01, FXServer answered "Couldn't find resource micaOS.", and since only a
# wrong password failed, every deploy reported a reload that never happened.
msg = b"\xff\xff\xff\xffrcon " + pw.encode() + b" restart mica"

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(5)
s.sendto(msg, ("127.0.0.1", port))
try:
    reply = s.recvfrom(65535)[0].decode(errors="replace")
except socket.timeout:
    # Fail, do not warn. A reload that silently did not happen is precisely
    # the bug this script exists to have stopped having.
    sys.exit(f"rcon: no response from 127.0.0.1:{port} within 5s -- micaOS NOT reloaded")
print(reply.strip())
if "Invalid password" in reply:
    sys.exit("rcon: server rejected the password -- micaOS NOT reloaded")
# Success has to be shown, not assumed: FXServer answers a restart it performed with
# "Stopping resource mica", and anything else (an unknown resource, a refused
# command) is a reload that did not happen.
if "Stopping resource mica" not in reply:
    sys.exit("rcon: the server did not restart mica -- micaOS NOT reloaded")
PYEOF

echo "reloaded micaOS on 127.0.0.1:$FIVEM_PORT"
completed=1
