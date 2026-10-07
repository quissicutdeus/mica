#!/bin/bash -p

# `-p` (MICA-316): privileged mode, so that when sudo runs this file bash neither sources
# $BASH_ENV nor $ENV, imports no exported function and ignores SHELLOPTS. refuse_bash_hooks below
# is the detector behind it. The path is fixed because an interpreter line cannot search PATH, and
# a hoth without /bin/bash fails at exec, before the identity line, which CI reports as no line.

# SPDX-FileCopyrightText: 2026 quissicutdeus
#
# SPDX-License-Identifier: AGPL-3.0-or-later

# Root-owned smoke-test wrapper (MICA-220). gphone can only invoke this exact
# script via sudoers; it cannot edit it. It takes one argument, a run directory
# that ~gphone/bin/smoke-release.sh has just unpacked a release zip into, and
# proves the zip is a resource FXServer can start: a throwaway MariaDB gets the
# zip's own mica.esx.sql imported, a throwaway FXServer from the stack's own
# image gets the zip's mica mounted read-only beside the stack's oxmysql, and
# the console has to say `mica started!` with no error from mica or oxmysql
# after it. Everything it starts is torn down on exit, whichever way it exits.
#
# Which run imports and which does not (MICA-306). micaOS creates its own schema on the first
# start of a database that holds no micaOS table, so the two modes below prove different halves
# of the install. The release smoke test imports the zip's mica.esx.sql first and keeps doing
# so: the file an owner may still import by hand has to import, and micaOS has to start on what
# it made. The integration suite does NOT import: it starts micaOS on an empty database, and
# the run is only a pass if the console says micaOS created the schema itself. There is no
# setting that makes the integration run import; a run that did would prove nothing about the
# first start, and the suite fails when `mica_integration_schema` is not `bootstrap`.
#
# What it trusts and what it does not. The run directory has to be under
# SMOKE_ROOT after realpath, be a directory, and contain no symlink -- and it is
# mounted read-only into a container running as the directory's owner, never as
# root. The deploy account can therefore run arbitrary JavaScript inside an
# unprivileged, short-lived FXServer, which is no more than its deploy key
# already lets it do to the live one.
#
# Settings live in ENV_FILE, root-owned, read one named key at a time rather
# than sourced. LICENSE_KEY is required: without one FXServer starts every
# resource and then quits, which proves the zip loads but not that mica
# reaches its database. A key registered for this box, and NOT the one either
# live stack uses -- two servers on one key will not both stay up -- is what
# makes the second half provable. MICA_SMOKE_KEYLESS=1 runs without one and
# says so on every line it prints; it exists for trying this script by hand.
#
# Integration mode (MICA-302). A run directory that also holds resources/mica-integration
# is the in-server integration suite rather than a release zip: the same throwaway
# MariaDB and FXServer, plus a per-run content keyring in a resource of its own
# (`mica_content_key_file`; see KEY_DIR below for why a resource),
# `mica_integration 1`, and the suite mounted read-only and ensured after mica. After
# `mica started!` the console has to print one `integration: done <P> passed <F> failed`
# within INTEGRATION_TIMEOUT, every `integration: PASS|FAIL|SKIP <id>` line is echoed here
# for the CI log, and any FAIL, a missing done line, a done line that disagrees with the
# lines it summarises, or a suite that ran nothing is a non-zero exit. A release zip
# never holds that directory (scripts/pack-resource.js refuses to write one that does),
# so the release smoke test cannot drift into this mode. Whatever the mode, a second
# invocation waits for the first: two servers on one licence key will not both stay up.
#
# Two runs, every time (MICA-304). An integration zip is run twice, one after the other, each on
# a database and a FXServer of its own: `standalone` (micaOS with no framework, no inventory and
# an empty database) and then `qbx` (oxmysql, ox_lib, qbx_core, ox_inventory, micaOS and the
# suite, on a database holding qbx_core's own tables and one character). There is no way to ask
# for one: nothing in the zip, the arguments or the environment picks, because a run that could
# be told to leave qbx out is one a stray edit could leave out unnoticed. Each run is held to
# the zip's expected-scenarios.txt (`<mode> pass|skip <id>`): the PASS lines must be exactly the
# scenarios of that run, and the SKIP lines exactly the other run's, each printed by the suite,
# so a scenario that went missing from either is a difference rather than a smaller count. A run
# that fails ends the invocation, and its messages are tagged `[standalone mode]` or `[qbx mode]`.
#
# Nothing the deploy account writes is trusted once it is read. It owns the run directory
# and runs pushed code, so any name there can be a symlink by the time root gets to it;
# root copies resources/ out without following links into a staging directory under a
# root-owned parent, checks the copy, and builds, mounts and chowns only there.
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

# Every command below resolves from a known path when this runs as root. sudo's own env_reset and
# secure_path should already hand over a clean PATH (the sudoers rules carry no SETENV, so a caller
# cannot set one), but nothing here may depend on it. $EUID is bash's own: it
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

# 3. A second line against bash's own start-up hooks (MICA-316). The first line is sudoers: the
#    rules for the deploy wrappers carry no SETENV, so sudo drops BASH_ENV and its kin before this
#    runs. This refuses the run when one is present anyway, and it is called right after the
#    identity line, before anything else.
#
#    What that can and cannot do. bash reads $BASH_ENV, imports exported functions and applies
#    SHELLOPTS before it executes the first line of this file, so by the time this runs a BASH_ENV
#    payload has already run, as this user. This is a detector, so a regression in sudoers fails
#    loudly instead of silently, and it stops the rest of the run from going on with whatever the
#    hook did. It cannot stop the payload. What does is `-p` on the interpreter line: in privileged
#    mode bash reads neither $BASH_ENV nor $ENV, imports no functions and ignores SHELLOPTS,
#    BASHOPTS, CDPATH and GLOBIGNORE. That holds when sudo runs the file by its interpreter line,
#    and not when somebody runs `bash <file>`. The dynamic loader's LD_* variables are not listed
#    because sudo itself, being setuid, loses them before it can pass them on.
#
#    SHELLOPTS, BASHOPTS and BASH_LOADABLES_PATH are always set, by bash, so being set says
#    nothing: what matters is that they are exported, which is how they came in on the environment.
refuse_bash_hooks() {
    local name decl flags found=''
    for name in BASH_ENV ENV CDPATH GLOBIGNORE; do
        [[ -z ${!name:-} ]] || found+=" $name"
    done
    for name in SHELLOPTS BASHOPTS BASH_LOADABLES_PATH; do
        decl=$(builtin declare -p "$name" 2>/dev/null) || continue
        flags=${decl#declare -}
        flags=${flags%% *}
        [[ $flags != *x* ]] || found+=" $name"
    done
    [[ -z $(builtin declare -Fx) ]] || found+=" BASH_FUNC_*%%(exported functions)"
    [[ -z $found ]] ||
        die "the environment carries a variable that changes how bash starts:$found. This wrapper runs as root and takes none of them. If BASH_ENV is one of them it has already run, because bash reads it before this script's first line: this refuses the run, and cannot undo that. The sudoers rule for this wrapper must not carry SETENV (scripts/deploy/README.md)."
}
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

# Second, and nothing before it but the identity line (MICA-316): the common block has why.
refuse_bash_hooks

SMOKE_ROOT=/home/gphone/smoke
ENV_FILE=/etc/mica-smoke.env

# Overridable from ENV_FILE. The defaults are the stack as scripts/deploy/README.md
# describes it: compose project `fivem`, so the image is `fivem-server`, and the
# main checkout's oxmysql, which the live main server already runs.
FX_IMAGE=fivem-server:latest
DB_IMAGE=mariadb:noble
OXMYSQL_DIR=/opt/fivem-main/server-data/vendor/oxmysql
# The qbx run's resources (MICA-304). Unset here: they default to the directories beside
# OXMYSQL_DIR, below, after ENV_FILE has had its say.
OX_LIB_DIR=
QBX_CORE_DIR=
OX_INVENTORY_DIR=
QBX_VEHICLES_DIR=
LICENSE_KEY=

# How long FXServer gets to print `mica started!`, and how long the server is
# then left running for mica's asynchronous start -- the oxmysql connection,
# the schema report, the orphan sweep's refusal on standalone -- to say anything.
START_TIMEOUT=180
SETTLE_SECONDS=20
# Integration mode only: how long after `mica started!` the suite has to finish.
INTEGRATION_TIMEOUT=300
# Root-owned place only: the staging directories each run is built in, not under the deploy
# account's home, which is the point. The lock is hoth's, shared with both deploys, and is
# taken below (hoth_lock, in the common block at the top).
STAGE_ROOT=/var/lib/mica-smoke
KEY_DIR=mica-keys
KEY_NAME=mica-content.key

# A trial by an ordinary user may point SMOKE_ROOT and ENV_FILE elsewhere. Under
# sudo this runs as root, and root ignores both: sudoers does not pass them and
# the trust root of a privileged script is not something its caller chooses.
if [[ $EUID -ne 0 ]]; then
    SMOKE_ROOT=${MICA_SMOKE_ROOT:-$SMOKE_ROOT}
    ENV_FILE=${MICA_SMOKE_ENV:-$ENV_FILE}
    # So server/__tests__/smokeWrapper.test.ts can reach the timeout paths in seconds.
    SETTLE_SECONDS=${MICA_SMOKE_SETTLE:-$SETTLE_SECONDS}
    INTEGRATION_TIMEOUT=${MICA_SMOKE_INTEGRATION_TIMEOUT:-$INTEGRATION_TIMEOUT}
    STAGE_ROOT=${MICA_SMOKE_STAGE:-${TMPDIR:-/tmp}/mica-smoke-stage-$EUID}
fi

run=${1:?usage: $0 <run directory under $SMOKE_ROOT>}
case "$run" in
    "$SMOKE_ROOT"/*) ;;
    *) die "$run is not under $SMOKE_ROOT" ;;
esac
real=$(realpath -e -- "$run") || die "$run does not exist"
case "$real" in
    "$SMOKE_ROOT"/*) ;;
    *) die "$run resolves to $real, outside $SMOKE_ROOT" ;;
esac
[[ -d $real ]] || die "$real is not a directory"

# One key per line, read by name. Sourcing the file would let it run anything.
if [[ -f $ENV_FILE ]]; then
    for key in LICENSE_KEY FX_IMAGE DB_IMAGE OXMYSQL_DIR OX_LIB_DIR QBX_CORE_DIR OX_INVENTORY_DIR QBX_VEHICLES_DIR; do
        value=$(grep -m1 "^${key}=" "$ENV_FILE" | cut -d= -f2- || true)
        [[ -n $value ]] && printf -v "$key" '%s' "$value"
    done
fi
# The qbx run's other three resources (MICA-304), from the same vendor directory as oxmysql: the
# main checkout's, which the live main server already runs. Mounted read-only, never written.
OX_LIB_DIR=${OX_LIB_DIR:-${OXMYSQL_DIR%/*}/ox_lib}
QBX_CORE_DIR=${QBX_CORE_DIR:-${OXMYSQL_DIR%/*}/qbx_core}
OX_INVENTORY_DIR=${OX_INVENTORY_DIR:-${OXMYSQL_DIR%/*}/ox_inventory}
# ox_inventory's qbx bridge refuses to load without qbx_vehicles (v1.2.0 or higher), and raises a
# script error that the run fails on.
QBX_VEHICLES_DIR=${QBX_VEHICLES_DIR:-${OXMYSQL_DIR%/*}/qbx_vehicles}

keyless=0
if [[ -z $LICENSE_KEY ]]; then
    if [[ ${MICA_SMOKE_KEYLESS:-} == 1 ]]; then
        keyless=1
        echo "smoke: KEYLESS -- no LICENSE_KEY, so FXServer will quit right after the resources start." >&2
        echo "smoke: KEYLESS -- this proves the zip loads and nothing past that." >&2
    else
        die "no LICENSE_KEY in $ENV_FILE. Register a key for this box at https://portal.cfx.re/ and write LICENSE_KEY=<key> there (0600, root-owned); a keyless run proves too little to release on. MICA_SMOKE_KEYLESS=1 overrides, for a trial by hand."
    fi
fi

# One job at a time on hoth, and the lock is taken before anything the box's other jobs can
# change. The key below is registered for one server, so a second run starting while the first
# is up would fail on the licence rather than on its own merits; and a dev deploy rebuilds the
# image this run starts a container from, so an image checked or used while one runs is a
# coin toss (MICA-315). Nothing the deploy account writes is read or trusted before this,
# because waiting here can take as long as another job does. The lock file is in a directory
# only root can write, shared with both deploys (see the common block at the top); a file in
# the deploy account's own tree is one it could hold forever or move.
hoth_lock "${real##*/}"

docker image inspect "$FX_IMAGE" >/dev/null 2>&1 ||
    die "no docker image $FX_IMAGE; set FX_IMAGE in $ENV_FILE to the stack's FXServer image (docker images | grep server)"
[[ -f $OXMYSQL_DIR/fxmanifest.lua ]] ||
    die "$OXMYSQL_DIR is not an oxmysql checkout; set OXMYSQL_DIR in $ENV_FILE"

# What the deploy account controls, and what root does with it.
#
# $real belongs to that account, which also runs whatever a push to dev makes it build, so
# any name in it can become a symlink at any moment. Root therefore never writes there, never
# chowns there, and never mounts from there. It opens the run directory once, copies
# `resources/` out of it without following a link (cp -P: a link is copied as a link), and
# does all the rest in a staging directory under a root-owned parent, where nothing of the
# account's can sit. The copy is then checked for links and special files, and everything
# below -- the manifest checks, the SQL import, the mounts, server-data, the keyring --
# comes from the copy.
exec 8<"$real"
pinned=$(readlink "/proc/$$/fd/8") || die "cannot pin $real"
case "$pinned" in
    "$SMOKE_ROOT"/*) ;;
    *) die "$real was replaced by something outside $SMOKE_ROOT" ;;
esac
owner=$(stat -L -c '%u:%g' "/proc/$$/fd/8")
# The container runs as the run directory's owner. Never as root.
[[ ${owner%%:*} -ne 0 ]] || die "$real is owned by root; the container must not run as root"

umask 022
if [[ $EUID -eq 0 ]]; then
    install -d -m 755 -o root -g root "$STAGE_ROOT"
else
    install -d -m 755 "$STAGE_ROOT"
fi
[[ -d $STAGE_ROOT && ! -L $STAGE_ROOT && $(stat -c %u "$STAGE_ROOT") -eq $EUID ]] ||
    die "$STAGE_ROOT is not a directory of this user's own"

stage=
net=
db=
fx=
# Which run a message belongs to: empty for the release smoke test, `[standalone mode] ` or
# `[qbx mode] ` for the two integration runs, so a failing job's log names the one that failed.
mode_tag=''
mdie() { die "$mode_tag$*"; }
# One run's containers and network, which a run removes when it ends and the exit trap removes
# when it does not (the names are set before the network is created, so a run that stopped
# between the two is cleaned too).
stop_run() {
    if [[ -n $fx ]]; then
        docker rm -f "$fx" "$db" >/dev/null 2>&1 || true
        docker network rm "$net" >/dev/null 2>&1 || true
    fi
    net=
    db=
    fx=
}
# Run by the common block's EXIT trap, while the lock is still held and before the final status
# line, whichever way the run ends.
wrapper_cleanup() {
    stop_run
    # The copy of the zip, server-data, FXServer's cache and the keyring: nothing of a run
    # outlives it.
    [[ -z $stage ]] || rm -rf -- "$stage"
}
# The scenario ids a mode's list holds for one kind (`pass`, `skip` or `(pass|skip)`), sorted:
# expected-scenarios.txt is `<mode> <kind> <id>` a line.
listed() { sed -nE "s/^$1 $2 //p" "$3" | sort; }

stage=$(mktemp -d "$STAGE_ROOT/run.XXXXXXXX")
chmod 755 "$stage"

# A hardlink in the zip's tree would let root copy a file gphone cannot read (a
# hardlink to /etc/mica-smoke.env) into staging, where the container reads it.
# fs.protected_hardlinks=1 forbids making one on hoth; this holds if it ever
# changes. Checked on the source, since `cp --no-preserve=all` drops the links
# and every staged copy has a link count of one.
if [[ -n $(find "/proc/$$/fd/8/resources" -type f -links +1 -print -quit) ]]; then
    die "the zip's resources/ holds a hardlinked file; the zip this repo ships carries none"
fi
cp -RP --no-preserve=all -- "/proc/$$/fd/8/resources" "$stage/src" ||
    die "could not copy resources/ out of $real"
[[ -d $stage/src && ! -L $stage/src ]] || die "resources/ in $real is not a plain directory"
if [[ -n $(find "$stage/src" \( -type l -o \( ! -type f ! -type d \) \) -print -quit) ]]; then
    die "the zip's resources/ holds a symlink or a special file ($(find "$stage/src" \( -type l -o \( ! -type f ! -type d \) \) -print -quit)); the zip this repo ships carries none"
fi
resource="$stage/src/mica"
[[ -f $resource/fxmanifest.lua ]] || die "mica/fxmanifest.lua is missing from the zip"
[[ -f $resource/mica.esx.sql ]] || die "mica/mica.esx.sql is missing from the zip"
integ="$stage/src/mica-integration"
integration=0
# The runs this invocation makes, in order. A release zip is one. The integration zip is the same
# suite twice, in two stacks (MICA-304), and nothing in the zip, the command line or the
# environment chooses between them: a run that could be asked to leave qbx out would be one a
# stray change could leave out quietly.
modes=(release)
if [[ -e $integ ]]; then
    integration=1
    modes=(standalone qbx)
    [[ -f $integ/fxmanifest.lua ]] || die "mica-integration/fxmanifest.lua is missing from the zip"
    [[ -f $integ/expected-scenarios.txt ]] ||
        die "mica-integration/expected-scenarios.txt is missing; without it a dropped scenario could not be told from a passed run"
    [[ -s $integ/expected-scenarios.txt ]] || die "mica-integration/expected-scenarios.txt is empty"
    if grep -qvE '^(standalone|qbx) (pass|skip) [a-z0-9][a-z0-9-]*$' "$integ/expected-scenarios.txt"; then
        die "mica-integration/expected-scenarios.txt holds a line that is not '<standalone|qbx> <pass|skip> <scenario id>'; the zip was packed by a packer that predates MICA-304, or by hand"
    fi
    for m in standalone qbx; do
        grep -qE "^$m pass " "$integ/expected-scenarios.txt" ||
            die "mica-integration/expected-scenarios.txt lists no scenario to pass in the $m run; a run that expects nothing proves nothing"
        [[ -z $(listed "$m" '(pass|skip)' "$integ/expected-scenarios.txt" | uniq -d) ]] ||
            die "mica-integration/expected-scenarios.txt lists a scenario twice in the $m run"
    done
    [[ $(listed standalone '(pass|skip)' "$integ/expected-scenarios.txt") == "$(listed qbx '(pass|skip)' "$integ/expected-scenarios.txt")" ]] ||
        die "mica-integration/expected-scenarios.txt lists different scenarios for the two runs; each must be a pass or a skip in both"
    # The qbx run's stack, checked before anything starts: a run that found out after the
    # standalone run's five minutes that its resources are missing would have wasted them.
    for dir in "$OX_LIB_DIR" "$QBX_CORE_DIR" "$QBX_VEHICLES_DIR" "$OX_INVENTORY_DIR"; do
        [[ -f $dir/fxmanifest.lua ]] ||
            die "$dir is not a resource checkout, and the qbx run needs it; set OX_LIB_DIR, QBX_CORE_DIR, QBX_VEHICLES_DIR and OX_INVENTORY_DIR in $ENV_FILE (they default to the directories beside OXMYSQL_DIR)"
    done
    [[ -f $QBX_CORE_DIR/qbx_core.sql ]] ||
        die "$QBX_CORE_DIR/qbx_core.sql is missing; qbx_core does not create its players table itself, so the qbx run imports this file first"
    [[ -f $QBX_VEHICLES_DIR/vehicles.sql ]] ||
        die "$QBX_VEHICLES_DIR/vehicles.sql is missing; qbx_vehicles reads player_vehicles, which it does not create, so the qbx run imports this file after qbx_core.sql"
fi

# Strip FXServer's colour codes so the patterns below see the words.
plain() { sed 's/\x1b\[[0-9;]*m//g'; }

report() {
    echo "---- FXServer console, ${mode_tag}mica, oxmysql and framework lines ----"
    docker logs "$fx" 2>&1 | plain | grep -iE 'mica|oxmysql|ox_lib|qbx|ox_inventory|resources\]|svadhesive|Quitting' || true
    echo "----------------------------------------------------"
}

# qbx mode's database (MICA-304). qbx_core does not create `players` at start, and micaOS reads
# it (the framework's own table, never created by micaOS), so it holds qbx_core's own schema
# before FXServer starts, imported from the resource's own file, and one character for the suite
# to look up offline. integration/lib/qbxSeed.ts names the same character, and
# server/__tests__/smokeWrapper.test.ts holds the two to each other. No micaOS table: the run is
# only a pass if micaOS creates its schema itself, against this `players`.
read -r -d '' QBX_SEED_SQL <<'SQL' || true
INSERT INTO players (citizenid, cid, license, name, money, charinfo, job, position, metadata)
VALUES (
    'ITXQBX01', 1, 'license:itxqbx01', 'Ada Quill',
    '{"cash":0,"bank":0,"crypto":0}',
    '{"firstname":"Ada","lastname":"Quill","phone":"5550100123","birthdate":"1990-01-01","gender":0,"nationality":"Los Santos","cid":1}',
    '{"name":"unemployed","label":"Civilian","payment":10,"type":"none","onduty":true,"isboss":false,"grade":{"name":"Freelancer","level":0}}',
    '{"x":0.0,"y":0.0,"z":0.0,"w":0.0}',
    '{}'
);
SQL

seed_qbx() {
    local count
    docker exec -i "$db" mariadb -uroot -psmoke mica <"$QBX_CORE_DIR/qbx_core.sql" ||
        mdie "qbx_core.sql from $QBX_CORE_DIR failed to import"
    count=$(docker exec "$db" mariadb -uroot -psmoke -N -e "select count(*) from information_schema.tables where table_schema='mica' and table_name='players'")
    [[ $count == 1 ]] || mdie "qbx_core.sql imported but the database holds no players table"
    # After qbx_core's, since its player_vehicles has a foreign key onto `players`.
    docker exec -i "$db" mariadb -uroot -psmoke mica <"$QBX_VEHICLES_DIR/vehicles.sql" ||
        mdie "vehicles.sql from $QBX_VEHICLES_DIR failed to import"
    docker exec -i "$db" mariadb -uroot -psmoke mica <<<"$QBX_SEED_SQL" ||
        mdie "could not seed the qbx_core players table with the suite's character"
    count=$(docker exec "$db" mariadb -uroot -psmoke mica -N -e "select count(*) from players where citizenid='ITXQBX01'")
    [[ $count == 1 ]] || mdie "the suite's character is not in the players table after seeding it"
    count=$(docker exec "$db" mariadb -uroot -psmoke -N -e "select count(*) from information_schema.tables where table_schema='mica' and table_name like 'mica\\_%'")
    [[ $count == 0 ]] || mdie "the database holds $count micaOS table(s) before micaOS starts, so the first-start schema would prove nothing"
    echo "smoke: imported qbx_core.sql and seeded one character; the database holds no micaOS table"
}

# One FXServer, start to verdict, against a database of its own. $1 is the run: `release` (the
# zip's own mica.esx.sql imported, mica started, the console left clean), or one of the two
# integration runs, `standalone` and `qbx`. A run that fails ends the invocation, naming itself.
run_mode() {
    local mode=$1 id sd mounts start_timeout deadline started logs running results tables
    local npass nfail nskip ndone want_pass want_skip got_pass got_skip created_re bridge_re
    id=${stage##*/run.}
    mode_tag=''
    [[ $mode == release ]] || mode_tag="[$mode mode] "
    net="mica-smoke-$mode-$id"
    db="mica-smoke-db-$mode-$id"
    fx="mica-smoke-fx-$mode-$id"

    docker network create "$net" >/dev/null

    case $mode in
        release) echo "smoke: starting $DB_IMAGE and importing the zip's mica.esx.sql" ;;
        standalone) echo "smoke: ${mode_tag}starting $DB_IMAGE, EMPTY: micaOS creates the schema itself on its first start" ;;
        qbx) echo "smoke: ${mode_tag}starting $DB_IMAGE with qbx_core's players table and a character in it; micaOS creates its own schema on its first start" ;;
    esac
    docker run -d --name "$db" --network "$net" \
        -e MARIADB_ROOT_PASSWORD=smoke -e MARIADB_DATABASE=mica \
        "$DB_IMAGE" >/dev/null
    # An authenticated query, not a ping: the image's first-boot init runs a
    # temporary server that answers ping before the root password exists, and an
    # import sent to that one is refused with "Access denied".
    ready() { docker exec "$db" mariadb -uroot -psmoke -e 'select 1' >/dev/null 2>&1; }
    for _ in $(seq 1 90); do
        ready && break
        sleep 1
    done
    ready || mdie "$DB_IMAGE did not accept a root login within 90s"
    # The release smoke test's import is itself half the test: the file an owner may import by
    # hand has to import. Standalone mode wants the ESX file: mica.sql reads qb's players table
    # first and fails without it, and this database has none. The standalone integration run
    # leaves the database empty, for micaOS to create (MICA-306): importing here would make the
    # first start a no-op. The qbx run holds qbx_core's own tables and no micaOS one.
    case $mode in
        release)
            docker exec -i "$db" mariadb -uroot -psmoke mica <"$resource/mica.esx.sql" ||
                mdie "mica.esx.sql from the zip failed to import"
            tables=$(docker exec "$db" mariadb -uroot -psmoke -N -e "select count(*) from information_schema.tables where table_schema='mica'")
            echo "smoke: imported mica.esx.sql -- $tables tables"
            ;;
        standalone)
            tables=$(docker exec "$db" mariadb -uroot -psmoke -N -e "select count(*) from information_schema.tables where table_schema='mica'")
            [[ $tables == 0 ]] || mdie "the database is not empty before micaOS starts ($tables tables), so the first-start schema would prove nothing"
            echo "smoke: the database holds no table; nothing imported"
            ;;
        qbx) seed_qbx ;;
    esac

    # A server-data of its own: the config below, and whatever FXServer writes beside it (its
    # cache). Everything in it is made here, by root, in a directory nothing else can write, and
    # only then handed to the run directory's owner -- the uid the container runs as -- so it can
    # write there and nowhere else. Noclobber on every file: a name already there is an error.
    sd="$stage/sd-$mode"
    mkdir "$sd" "$sd/resources" "$sd/resources/oxmysql" "$sd/resources/mica"
    [[ $mode != qbx ]] || mkdir "$sd/resources/ox_lib" "$sd/resources/qbx_core" "$sd/resources/qbx_vehicles" "$sd/resources/ox_inventory"
    set -C
    if [[ $integration == 1 ]]; then
        mkdir "$sd/resources/mica-integration" "$sd/resources/$KEY_DIR"
        # A valid keyring, one line `<id> <base64 of 32 random bytes>`, made fresh for this run
        # and 0600 for the container's user. Nothing durable ever holds it: it dies with $stage.
        #
        # It lives in a resource of its own, `mica-keys`, and the reason is FXServer's Node
        # permission model, measured against the stack's image: a resource may read any file
        # under a resource folder (its own or another's) and nothing else. A key in server-data,
        # in resources/, in a plain or [category] directory, or anywhere outside is refused with
        # "no device found", and mica turns content encryption off. `add_filesystem_permission`
        # does not lift that for reads: seven spellings of it were tried and every read stayed
        # refused. A directory is a resource when it holds an fxmanifest.lua; it need not be
        # ensured.
        : >"$sd/resources/$KEY_DIR/fxmanifest.lua"
        (
            umask 077
            printf 'it1 %s\n' "$(head -c 32 /dev/urandom | base64 -w0)" >"$sd/resources/$KEY_DIR/$KEY_NAME"
        )
    fi
    {
        echo 'endpoint_add_tcp "0.0.0.0:30120"'
        echo 'endpoint_add_udp "0.0.0.0:30120"'
        echo 'set sv_hostname "mica release smoke"'
        echo 'set sv_maxclients 1'
        [[ $keyless == 1 ]] || echo "set sv_licenseKey \"$LICENSE_KEY\""
        echo 'set mysql_connection_string "mysql://root:smoke@'"$db"':3306/mica?charset=utf8mb4"'
        if [[ $mode == qbx ]]; then
            # qbx_core refuses to start, and quits the server, unless OneSync Infinity is on and
            # ox_inventory is on the qbx bridge (server/main.lua checks both). No `mica_standalone`:
            # beside a framework it is a conflict micaOS reports, not a mode. The two after are
            # network calls and a banner the run has no use for, and `mica_phone_item` is what
            # makes micaOS register the phone as a usable item at all (it gates nothing by default).
            echo 'set onesync on'
            echo 'setr inventory:framework "qbx"'
            echo 'set inventory:versioncheck "false"'
            echo 'set qbx:acknowledge "true"'
            echo 'set mica_phone_item "phone"'
        else
            echo 'set mica_standalone 1'
        fi
        if [[ $integration == 1 ]]; then
            echo "set mica_content_key_file \"/opt/fivem/server-data/resources/$KEY_DIR/$KEY_NAME\""
            echo 'set mica_integration "1"'
            # Which of the two runs this is; the suite fails on anything else, so a wrapper that
            # predates the modes cannot run one stack's scenarios against the other.
            echo "set mica_integration_mode \"$mode\""
            # What the suite reads to know micaOS, not an import, made the schema it is run
            # against. A wrapper that predates MICA-306 sets nothing, and the suite fails on that.
            echo 'set mica_integration_schema "bootstrap"'
        fi
        echo 'ensure oxmysql'
        # In the order qbx_core's own documentation gives, with micaOS after the framework it
        # detects: micaOS reads qbx_core's exports as it loads, and registers its phone item then.
        # qbx_vehicles after qbx_core and before ox_inventory, whose qbx bridge needs it loaded.
        [[ $mode != qbx ]] || printf 'ensure %s\n' ox_lib qbx_core qbx_vehicles ox_inventory
        echo 'ensure mica'
        [[ $integration != 1 ]] || echo 'ensure mica-integration'
    } >"$sd/server.cfg"
    set +C
    chmod 600 "$sd/server.cfg"
    chown -R "$owner" "$sd"

    echo "smoke: ${mode_tag}starting $FX_IMAGE with the zip's mica and $OXMYSQL_DIR"
    # `-w`: the image's entrypoint renders server.cfg from a template only when none
    # exists in its working directory, then execs run.sh there. `+exec` is what the
    # stack's own compose deliberately never passes (it would skip txAdmin's wizard);
    # here there is no txAdmin and skipping it is the point.
    # `-i`: FXServer reads its console from stdin and treats end-of-file as Ctrl-C,
    # so a detached container with stdin closed prints `mica started!` and then
    # "Quitting: Ctrl-C pressed in server console." The live stacks run with stdin
    # open too. Invisible until a real key let the run get past startup.
    mounts=(
        -v "$sd:/opt/fivem/server-data"
        -v "$OXMYSQL_DIR:/opt/fivem/server-data/resources/oxmysql:ro"
        -v "$resource:/opt/fivem/server-data/resources/mica:ro"
    )
    if [[ $mode == qbx ]]; then
        echo "smoke: ${mode_tag}mounting $OX_LIB_DIR, $QBX_CORE_DIR, $QBX_VEHICLES_DIR and $OX_INVENTORY_DIR read-only, and ensuring them before mica"
        mounts+=(
            -v "$OX_LIB_DIR:/opt/fivem/server-data/resources/ox_lib:ro"
            -v "$QBX_CORE_DIR:/opt/fivem/server-data/resources/qbx_core:ro"
            -v "$QBX_VEHICLES_DIR:/opt/fivem/server-data/resources/qbx_vehicles:ro"
            -v "$OX_INVENTORY_DIR:/opt/fivem/server-data/resources/ox_inventory:ro"
        )
    fi
    if [[ $integration == 1 ]]; then
        echo "smoke: ${mode_tag}INTEGRATION -- mica-integration is in the zip; mounting it and ensuring it after mica"
        mounts+=(-v "$integ:/opt/fivem/server-data/resources/mica-integration:ro")
    fi
    docker run -d -i --name "$fx" --network "$net" --user "$owner" \
        -w /opt/fivem/server-data \
        "${mounts[@]}" \
        "$FX_IMAGE" +exec server.cfg >/dev/null

    # The qbx stack loads four resources micaOS does not, and qbx_core alone is hundreds of files.
    start_timeout=$START_TIMEOUT
    [[ $mode != qbx ]] || start_timeout=$((START_TIMEOUT + 60))
    started=0
    deadline=$((SECONDS + start_timeout))
    while ((SECONDS < deadline)); do
        logs=$(docker logs "$fx" 2>&1 | plain || true)
        if grep -q 'mica started!' <<<"$logs"; then
            started=1
            break
        fi
        if grep -qiE "Couldn't find resource mica|Failed to (load|start) resource mica|Could not (load|start) resource mica" <<<"$logs"; then
            break
        fi
        if [[ $(docker inspect -f '{{.State.Running}}' "$fx" 2>/dev/null) != true ]]; then
            break
        fi
        sleep 2
    done

    if [[ $started != 1 ]]; then
        report
        mdie "FXServer never printed 'mica started!' within ${start_timeout}s -- the zip does not start as a resource"
    fi

    if [[ $keyless == 1 && $integration != 1 ]]; then
        report
        echo "smoke: KEYLESS -- mica started; FXServer quits without a key, so its database start is NOT proven"
        completed=1
        exit 0
    fi

    # The keyed half. The server stays up, so mica's asynchronous start gets a
    # fixed window to complain in, and then the console is read for the things that
    # would make a released zip a bad one: a script error from mica, or oxmysql
    # failing to connect to a database that was imported seconds ago.
    #
    # In integration mode the window is the suite itself: it ends at the first of the done
    # line, the container stopping, or INTEGRATION_TIMEOUT. The running state is read before
    # the logs, so a container seen stopped has had its last line read.
    local done_re='integration: done ([0-9]+) passed ([0-9]+) failed'
    if [[ $integration == 1 ]]; then
        echo "smoke: ${mode_tag}INTEGRATION -- waiting up to ${INTEGRATION_TIMEOUT}s for the suite's done line"
        deadline=$((SECONDS + INTEGRATION_TIMEOUT))
        while :; do
            running=$(docker inspect -f '{{.State.Running}}' "$fx" 2>/dev/null || true)
            logs=$(docker logs "$fx" 2>&1 | plain || true)
            grep -qE "$done_re" <<<"$logs" && break
            [[ $running == true ]] || break
            ((SECONDS < deadline)) || break
            sleep 2
        done
    else
        sleep "$SETTLE_SECONDS"
        logs=$(docker logs "$fx" 2>&1 | plain || true)
    fi
    report

    if [[ $integration == 1 ]]; then
        # From the first match to the end of the line, so a console prefix is dropped and a
        # message that itself mentions "integration:" is kept whole.
        results=$(grep -oE 'integration: (PASS|FAIL|SKIP|done|mode) .*' <<<"$logs" || true)
        echo "---- integration results ${mode_tag}----"
        echo "$results"
        echo "-----------------------------"
        npass=$(grep -c '^integration: PASS ' <<<"$results" || true)
        nfail=$(grep -c '^integration: FAIL ' <<<"$results" || true)
        nskip=$(grep -c '^integration: SKIP ' <<<"$results" || true)
        ndone=$(grep -cE "^$done_re" <<<"$results" || true)
        ((nfail == 0)) || mdie "$nfail integration scenario(s) FAILED; the FAIL lines are above"
        if ((ndone == 0)); then
            if [[ $running == true ]]; then
                mdie "no 'integration: done' line within ${INTEGRATION_TIMEOUT}s of 'mica started!'; the suite hung or never ran"
            fi
            mdie "FXServer stopped before the suite printed 'integration: done'; its last console lines are above"
        fi
        ((ndone == 1)) || mdie "the suite printed 'integration: done' $ndone times"
        [[ $(grep -E "^$done_re" <<<"$results") =~ $done_re ]]
        if ((BASH_REMATCH[1] != npass || BASH_REMATCH[2] != nfail)); then
            mdie "the done line says ${BASH_REMATCH[1]} passed ${BASH_REMATCH[2]} failed but the console holds $npass PASS and $nfail FAIL lines"
        fi
        ((npass > 0)) || mdie "the suite finished having run no scenario; that is not a pass"
        # The suite says which run it thinks it is, once, and it is the run this wrapper set up:
        # the convar reached it, and it ran the scenarios of the stack it was started beside.
        [[ $(grep -c "^integration: mode $mode\$" <<<"$results" || true) == 1 ]] ||
            mdie "the suite did not say 'integration: mode $mode' exactly once; it ran as another mode or no mode"
        # Exactly the scenarios the zip was packed to run in this mode, and exactly the ones it
        # was packed to skip. A group dropped from the suite's index still prints a clean done
        # line with a smaller count, and one never registered for this mode prints nothing at all;
        # both are a difference here, in the pass list or the skip list, which the packer wrote
        # from the source tree.
        got_pass=$(grep '^integration: PASS ' <<<"$results" | sed -E 's/^integration: PASS ([^ ]+).*/\1/' | sort)
        want_pass=$(listed "$mode" pass "$integ/expected-scenarios.txt")
        got_skip=$(grep '^integration: SKIP ' <<<"$results" | sed -E 's/^integration: SKIP ([^ :]+).*/\1/' | sort || true)
        want_skip=$(listed "$mode" skip "$integ/expected-scenarios.txt")
        if [[ $got_pass != "$want_pass" ]]; then
            echo "---- expected scenarios (<) against the PASS lines (>) ----" >&2
            diff <(echo "$want_pass") <(echo "$got_pass") >&2 || true
            mdie "the PASS lines are not the scenarios this zip was packed with for the $mode run"
        fi
        if [[ $got_skip != "$want_skip" ]]; then
            echo "---- expected skips (<) against the SKIP lines (>) ----" >&2
            diff <(echo "$want_skip") <(echo "$got_skip") >&2 || true
            mdie "the SKIP lines are not the scenarios this zip was packed to skip in the $mode run"
        fi
        # MICA-306: micaOS made every table the suite ran against, on a database that held none of
        # its own, and the console says so exactly once, from micaOS, naming the shape it made.
        # The suite reads the tables and the ledger back; only the whole console holds this line,
        # since the suite's own listener starts after micaOS has begun talking. A refusal prints
        # the reason instead, and the lines that say why are shown.
        if [[ $mode == qbx ]]; then
            created_re="created micaOS's schema for qbx/qb"
            # And micaOS's bridge took qbx_core, not a qb core or nothing (MICA-227's line, which
            # names what answered for jobs). The suite starts too late to hear it.
            bridge_re='mica: jobs -> qbx_core '
        else
            created_re="created micaOS's schema for ESX or standalone"
            bridge_re=''
        fi
        if ! grep -qF "$created_re" <<<"$logs"; then
            echo "---- micaOS's schema lines ----" >&2
            grep -iE "\[mica\].*(schema|half-created|database)" <<<"$logs" >&2 || true
            mdie "the console never said micaOS created its schema (\"$created_re ...\") on a database holding none of its own; the first-start schema is unproven"
        fi
        if [[ -n $bridge_re ]] && ! grep -qF "$bridge_re" <<<"$logs"; then
            echo "---- micaOS's bridge lines ----" >&2
            grep -iE 'mica: (jobs|banking)|FrameworkBridge' <<<"$logs" >&2 || true
            mdie "the console never said micaOS's bridge took qbx_core (\"$bridge_re...\"); micaOS did not detect the framework it was started beside"
        fi
        if [[ $mode == qbx ]] && grep -qF 'mica_standalone is set, but' <<<"$logs"; then
            mdie "micaOS reported mica_standalone set beside the framework; the qbx run must leave it out"
        fi
        # The verdict lines are the suite's own and can say anything; what follows is for what
        # the console says about everything else.
        logs=$(grep -vE 'integration: (PASS|FAIL|SKIP|done|mode) ' <<<"$logs" || true)
    elif [[ $(docker inspect -f '{{.State.Running}}' "$fx" 2>/dev/null) != true ]]; then
        mdie "FXServer exited after mica started; with a key it should stay up. Its last console lines above say why: 'Quitting: Ctrl-C' is stdin closing, a licence error is the key, and a key already in use on another server also ends it"
    fi
    if [[ $integration == 1 ]]; then
        # The suite provokes micaOS's refusals on purpose and some print the word "Error" on
        # mica's own channel (`keygen refused: ... (Error: EACCES ...)`), so a line that merely
        # contains it says nothing. What does is the shape FXServer gives a resource that is
        # broken: a SCRIPT ERROR, an unhandled rejection or uncaught exception, a Lua stack
        # traceback, a resource that did not start. Behaviour is the scenarios' verdict.
        local broken='SCRIPT ERROR|unhandled.?(promise)?.?rejection|uncaught (exception|error)|stack traceback|(failed|could not|couldn.t) (to )?(load|start) resource'
        if grep -qiE "$broken" <<<"$logs"; then
            echo "---- lines that look like a broken resource ----" >&2
            grep -iE "$broken" <<<"$logs" >&2 || true
            mdie "a resource failed or raised a script error while the suite ran"
        fi
    elif grep -iE 'script:mica' <<<"$logs" | grep -qiE 'error|exception|unhandled'; then
        mdie "mica logged an error after starting"
    fi
    if grep -iE 'oxmysql' <<<"$logs" | grep -qiE 'error|refused|denied|unable to (connect|establish)'; then
        mdie "oxmysql could not reach the database it was started against"
    fi
    if [[ $integration == 1 ]]; then
        [[ $keyless != 1 ]] || echo "smoke: KEYLESS -- the console above is all this run could prove"
        echo "smoke: ${mode_tag}integration suite passed -- $npass scenarios passed, $nskip skipped (each named above), and the console stayed clean"
        ran+=("$mode: $npass passed, $nskip skipped")
    else
        echo "smoke: mica started against mica.esx.sql and stayed clean for ${SETTLE_SECONDS}s"
    fi
    stop_run
    mode_tag=''
}

ran=()
for mode in "${modes[@]}"; do
    run_mode "$mode"
done
if [[ $integration == 1 ]]; then
    echo "smoke: integration passed in every run -- ${ran[0]}; ${ran[1]}"
fi
completed=1
