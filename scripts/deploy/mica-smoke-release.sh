#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 quissicutdeus
#
# SPDX-License-Identifier: AGPL-3.0-or-later

# The smoke-test wrapper (MICA-220), run on hoth as the fivem account, which owns the game
# servers and runs every container there rootless. It takes one argument, a run directory that
# ~/bin/smoke-release.sh has just unpacked a release zip into, and proves the zip is a resource
# FXServer can start: a throwaway MariaDB gets the zip's own mica.esx.sql imported, a throwaway
# FXServer from the stack's own image gets the zip's mica mounted read-only beside the stack's
# oxmysql, and the console has to say `mica started!` with no error from mica or oxmysql after
# it. Everything it starts is torn down on exit, whichever way it exits.
#
# The dev deploy (deploy.sh) installs this file and smoke-release.sh into ~/bin from the dev
# checkout, by rename, so the copy hoth runs is dev's and never a hand-installed one that
# drifted (scripts/deploy/README.md).
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
# What it runs and as whom. The zip's code runs inside an unprivileged, short-lived FXServer,
# as the run directory's owner mapped into the container (`--userns=keep-id`), which is no more
# than the deploy key already lets pushed code do to the live servers.
#
# Settings live in ENV_FILE, 0600 and the account's own, read one named key at a time rather
# than sourced. LICENSE_KEY is required: without one FXServer starts every resource and then
# quits, which proves the zip loads but not that mica reaches its database. A key registered for
# this box, and NOT the one either live stack uses -- two servers on one key will not both stay
# up -- is what makes the second half provable. MICA_SMOKE_KEYLESS=1 runs without one and says
# so on every line it prints; it exists for trying this script by hand.
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
# Three runs, every time (MICA-304). An integration zip is run three times, one after the other,
# each on a database and a FXServer of its own: `standalone` (micaOS with no framework, no
# inventory and an empty database), then `qbx` (oxmysql, ox_lib, qbx_core, ox_inventory, micaOS
# and the suite, on a database holding qbx_core's own tables and one character), then `esx`
# (oxmysql, ox_lib, esx_lib, es_extended, ox_inventory, micaOS and the suite, on a database
# holding ESX Legacy's own tables and one character). There is no way to ask for one: nothing in
# the zip, the arguments or the environment picks, because a run that could be told to leave one
# out is one a stray edit could leave out unnoticed. Each run is held to the zip's
# expected-scenarios.txt (`<mode> pass|skip <id>`): the PASS lines must be exactly the scenarios
# of that run, and the SKIP lines exactly the other runs', each printed by the suite, so a
# scenario that went missing from any is a difference rather than a smaller count. A run that
# fails ends the invocation, and its messages are tagged `[standalone mode]`, `[qbx mode]` or
# `[esx mode]`.
#
# The run is built from a copy, never from the run directory. The zip's tree is copied out
# without following links into a staging directory of this run's own, the copy is checked for
# links and special files, and everything below -- the manifest checks, the SQL import, the
# mounts, server-data, the keyring -- comes from it, so a link in the zip cannot mount or read a
# file of the host's into the container, and nothing is ever written into the run directory.
set -euo pipefail

# BEGIN wrapper-common
# Nothing here prints before the run's last line unless something is wrong or the box is busy.
#
# 1. No silent exit (MICA-315). `set -e` ends a run at a failing command and says nothing, and on
#    2026-10-06 an integration run's CI log stopped at "smoke: starting mariadb:noble" with exit 1
#    and no reason. So the ERR trap names a failing command (set -E carries it into functions),
#    every deliberate exit goes through die() or prints its own reason, and the EXIT trap ends
#    every run with one status line. Only a failure in the main shell is reported: the shell that
#    ran a failing `$(...)` reports the assignment itself, once.
# 2. One job at a time on hoth. The two deploys and the smoke and integration runs share the box's
#    images, its container store and licence key, and a deploy rebuilding an image under a run
#    that is about to start a container from it is how the run above died. They take one lock,
#    the fivem account's ${XDG_RUNTIME_DIR}/mica-hoth.lock (deploy.sh takes the same file), and
#    hold it to the end of the run, cleanup included.
set -E
wrapper_name=${0##*/}
explained=0
hoth_locked=0
# Set as the last act of a run that got to its end. An exit status of 0 without it is a run that
# was cut short, which is how a signal looks to the EXIT trap: bash runs it with the status of the
# last command, not the signal's, and a trap that believed that would report a killed run as a pass.
completed=0

# How long a job waits for the box. A deploy holds it for 1 to 3 minutes and an integration run for
# 5 to 10 (90s for the database, 180s to start and 300s for the suite, at most), and a release
# makes two runs back to back. 1500s outlasts two of the longest, so a job queued behind a run and
# another job still goes, and it is far short of hanging a CI job on a holder that is stuck.
# A trial by hand or by the smokeWrapper*.test.ts suites may point the lock elsewhere and
# shorten the wait; a CI session cannot, since sshd passes a forced command no environment.
HOTH_LOCK_FILE=${MICA_HOTH_LOCK:-${XDG_RUNTIME_DIR:-/run/user/$EUID}/mica-hoth.lock}
HOTH_LOCK_TIMEOUT=${MICA_HOTH_LOCK_TIMEOUT:-1500}
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
    # The note comes from the caller and lands in other jobs' logs.
    note=${note//[^[:print:]]/?}
    [[ $HOTH_LOCK_TIMEOUT =~ ^[0-9]+$ ]] || die "the lock timeout '$HOTH_LOCK_TIMEOUT' is not a number of seconds"
    command -v flock >/dev/null || die "flock is not installed; hoth's jobs cannot be serialised, so none may run"
    [[ ! -L $HOTH_LOCK_FILE ]] || die "$HOTH_LOCK_FILE is a symlink; it must be a plain file this user owns"
    old_umask=$(umask)
    umask 022
    exec 9>>"$HOTH_LOCK_FILE" || die "cannot open the lock file $HOTH_LOCK_FILE"
    umask "$old_umask"
    # Judged on the open file, not the path, so nothing can be swapped in between. A lock another
    # account could write is one it could fill with a false holder or replace.
    info=$(stat -L -c '%u %a' "/proc/$$/fd/9") || die "cannot stat the lock file $HOTH_LOCK_FILE"
    owner=${info% *}
    mode=${info#* }
    [[ $owner == "$EUID" ]] || die "$HOTH_LOCK_FILE is owned by uid $owner, not by this user; refusing a lock someone else made"
    (((8#$mode & 022) == 0)) || die "$HOTH_LOCK_FILE is writable by group or others (mode $mode); refusing a lock another account could tamper with"
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

# `~`, not $HOME: bash falls back to the account's passwd entry when HOME is unset.
SMOKE_ROOT=${MICA_SMOKE_ROOT:-~/smoke}
ENV_FILE=${MICA_SMOKE_ENV:-~/.config/mica-smoke/smoke.env}

# Overridable from ENV_FILE. The defaults are the stack as scripts/deploy/README.md describes
# it: the main server's image, and the main checkout's oxmysql, which the live main server
# already runs.
FX_IMAGE=localhost/fivem-main-server:latest
DB_IMAGE=docker.io/library/mariadb:noble
OXMYSQL_DIR=/opt/fivem-main/server-data/vendor/oxmysql
# The qbx run's resources (MICA-304). Unset here: they default to the directories beside
# OXMYSQL_DIR, below, after ENV_FILE has had its say.
OX_LIB_DIR=
QBX_CORE_DIR=
OX_INVENTORY_DIR=
QBX_VEHICLES_DIR=
# The esx run's resources (MICA-304). Not beside OXMYSQL_DIR: the live servers run no ESX, so
# these are installed for this box alone, root-owned and read-only, from one esx_core release
# (scripts/deploy/README.md names the tag). ESX_LIB_DIR and ESX_SQL default beside ESX_DIR, below.
ESX_DIR=/opt/mica-smoke/vendor/es_extended
ESX_LIB_DIR=
ESX_SQL=
LICENSE_KEY=

# How long FXServer gets to print `mica started!`, and how long the server is
# then left running for mica's asynchronous start -- the oxmysql connection,
# the schema report, the orphan sweep's refusal on standalone -- to say anything.
START_TIMEOUT=180
SETTLE_SECONDS=20
# Integration mode only: how long after `mica started!` the suite has to finish.
# server/__tests__/integrationRunner.test.ts reads this line, as written, against the suite's own
# budget.
INTEGRATION_TIMEOUT=300
# So the server/__tests__/smokeWrapper*.test.ts suites can reach the timeout paths in seconds.
SETTLE_SECONDS=${MICA_SMOKE_SETTLE:-$SETTLE_SECONDS}
INTEGRATION_TIMEOUT=${MICA_SMOKE_INTEGRATION_TIMEOUT:-$INTEGRATION_TIMEOUT}
# The staging directories each run is built in, outside the run directory, which is the point.
STAGE_ROOT=${MICA_SMOKE_STAGE:-~/.cache/mica-smoke-stage}
KEY_DIR=mica-keys
KEY_NAME=mica-content.key

# A test-only clock. With MICA_SMOKE_FAKE_CLOCK=1 every wait and deadline below (the database
# wait, the start wait, the suite wait and the settle) runs on a counter that nap() advances
# instead of on real time, so the smokeWrapper*.test.ts suites reach a timeout path
# without waiting for it. The lock wait keeps real time. A CI session cannot set it: sshd passes
# the forced command no environment.
fake_clock=0
fake_elapsed=0
if [[ -n ${MICA_SMOKE_FAKE_CLOCK:-} ]]; then
    fake_clock=1
fi
# Seconds on the clock the waits below read, and a wait on it.
clock_now() {
    if ((fake_clock)); then echo "$fake_elapsed"; else echo "$SECONDS"; fi
}
nap() {
    if ((fake_clock)); then fake_elapsed=$((fake_elapsed + $1)); else sleep "$1"; fi
}

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
    for key in LICENSE_KEY FX_IMAGE DB_IMAGE OXMYSQL_DIR OX_LIB_DIR QBX_CORE_DIR OX_INVENTORY_DIR QBX_VEHICLES_DIR ESX_DIR ESX_LIB_DIR ESX_SQL; do
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
# es_extended's fxmanifest loads `@esx_lib/imports.lua`, so the esx run cannot start without
# esx_lib beside it. The SQL is esx_core's `[SQL]/legacy.sql`, not es_extended.sql: that file
# creates and `USE`s a database of its own and holds no firstname, lastname, phone_number or
# licenses (which ox_inventory's esx bridge writes to), and es_extended's own migrations then
# alter the tables it lacks and ask for a restart that never comes.
ESX_LIB_DIR=${ESX_LIB_DIR:-${ESX_DIR%/*}/esx_lib}
ESX_SQL=${ESX_SQL:-${ESX_DIR%/*}/legacy.sql}

keyless=0
if [[ -z $LICENSE_KEY ]]; then
    if [[ ${MICA_SMOKE_KEYLESS:-} == 1 ]]; then
        keyless=1
        echo "smoke: KEYLESS -- no LICENSE_KEY, so FXServer will quit right after the resources start." >&2
        echo "smoke: KEYLESS -- this proves the zip loads and nothing past that." >&2
    else
        die "no LICENSE_KEY in $ENV_FILE. Register a key for this box at https://portal.cfx.re/ and write LICENSE_KEY=<key> there (0600, this account's own); a keyless run proves too little to release on. MICA_SMOKE_KEYLESS=1 overrides, for a trial by hand."
    fi
fi

# One job at a time on hoth, and the lock is taken before anything the box's other jobs can
# change. The key below is registered for one server, so a second run starting while the first
# is up would fail on the licence rather than on its own merits; and a dev deploy rebuilds the
# image this run starts a container from, so an image checked or used while one runs is a
# coin toss (MICA-315). Nothing in the run directory is read before this, because waiting here
# can take as long as another job does. The lock is the one both deploys take (see the common
# block at the top).
hoth_lock "${real##*/}"

podman image inspect "$FX_IMAGE" >/dev/null 2>&1 ||
    die "no image $FX_IMAGE in this account's podman; set FX_IMAGE in $ENV_FILE to the stack's FXServer image (podman images | grep server)"
[[ -f $OXMYSQL_DIR/fxmanifest.lua ]] ||
    die "$OXMYSQL_DIR is not an oxmysql checkout; set OXMYSQL_DIR in $ENV_FILE"

# The run directory holds what the zip unpacked to, and the zip is what a push built, so any
# name in it may be a symlink. Nothing here writes there or mounts from there. The directory is
# opened once, `resources/` is copied out of it without following a link (cp -P: a link is
# copied as a link) into a staging directory of this run's own, the copy is checked for links
# and special files, and everything below -- the manifest checks, the SQL import, the mounts,
# server-data, the keyring -- comes from the copy.
exec 8<"$real"
pinned=$(readlink "/proc/$$/fd/8") || die "cannot pin $real"
case "$pinned" in
    "$SMOKE_ROOT"/*) ;;
    *) die "$real was replaced by something outside $SMOKE_ROOT" ;;
esac
owner=$(stat -L -c '%u:%g' "/proc/$$/fd/8")
# The FXServer container runs as the run directory's owner, which has to be this account: it is
# the uid `--userns=keep-id` maps into the container, and the one that owns the staged
# server-data FXServer writes into.
[[ ${owner%%:*} == "$EUID" ]] || die "$real is owned by uid ${owner%%:*}, not by this account (uid $EUID)"

umask 022
install -d -m 755 "$STAGE_ROOT"
[[ -d $STAGE_ROOT && ! -L $STAGE_ROOT && $(stat -c %u "$STAGE_ROOT") -eq $EUID ]] ||
    die "$STAGE_ROOT is not a directory of this user's own"

stage=
net=
db=
fx=
# Which run a message belongs to: empty for the release smoke test, `[standalone mode] `,
# `[qbx mode] ` or `[esx mode] ` for the integration runs, so a failing job's log names the one
# that failed.
mode_tag=''
mdie() { die "$mode_tag$*"; }
# One run's containers and network, which a run removes when it ends and the exit trap removes
# when it does not (the names are set before the network is created, so a run that stopped
# between the two is cleaned too).
stop_run() {
    if [[ -n $fx ]]; then
        podman rm -f "$fx" "$db" >/dev/null 2>&1 || true
        podman network rm "$net" >/dev/null 2>&1 || true
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

# A hardlink in the zip's tree would copy a file of the host's (a hardlink to the
# settings file, which holds the licence key) into staging, where the container
# reads it. The zip this repo ships carries none. Checked on the source, since
# `cp --no-preserve=all` drops the links and every staged copy has a link count
# of one.
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
# suite three times, in three stacks (MICA-304), and nothing in the zip, the command line or the
# environment chooses between them: a run that could be asked to leave one out would be one a
# stray change could leave out quietly.
modes=(release)
if [[ -e $integ ]]; then
    integration=1
    modes=(standalone qbx esx)
    [[ -f $integ/fxmanifest.lua ]] || die "mica-integration/fxmanifest.lua is missing from the zip"
    [[ -f $integ/expected-scenarios.txt ]] ||
        die "mica-integration/expected-scenarios.txt is missing; without it a dropped scenario could not be told from a passed run"
    [[ -s $integ/expected-scenarios.txt ]] || die "mica-integration/expected-scenarios.txt is empty"
    if grep -qvE '^(standalone|qbx|esx) (pass|skip) [a-z0-9][a-z0-9-]*$' "$integ/expected-scenarios.txt"; then
        die "mica-integration/expected-scenarios.txt holds a line that is not '<standalone|qbx|esx> <pass|skip> <scenario id>'; the zip was packed by a packer that predates MICA-304 or its esx run, or by hand"
    fi
    for m in standalone qbx esx; do
        grep -qE "^$m pass " "$integ/expected-scenarios.txt" ||
            die "mica-integration/expected-scenarios.txt lists no scenario to pass in the $m run; a run that expects nothing proves nothing"
        [[ -z $(listed "$m" '(pass|skip)' "$integ/expected-scenarios.txt" | uniq -d) ]] ||
            die "mica-integration/expected-scenarios.txt lists a scenario twice in the $m run"
    done
    for m in qbx esx; do
        [[ $(listed standalone '(pass|skip)' "$integ/expected-scenarios.txt") == "$(listed "$m" '(pass|skip)' "$integ/expected-scenarios.txt")" ]] ||
            die "mica-integration/expected-scenarios.txt lists different scenarios for the standalone and $m runs; each must be a pass or a skip in all"
    done
    # The qbx and esx runs' stacks, checked before anything starts: a run that found out after
    # the standalone run's five minutes that its resources are missing would have wasted them.
    for dir in "$OX_LIB_DIR" "$QBX_CORE_DIR" "$QBX_VEHICLES_DIR" "$OX_INVENTORY_DIR"; do
        [[ -f $dir/fxmanifest.lua ]] ||
            die "$dir is not a resource checkout, and the qbx run needs it; set OX_LIB_DIR, QBX_CORE_DIR, QBX_VEHICLES_DIR and OX_INVENTORY_DIR in $ENV_FILE (they default to the directories beside OXMYSQL_DIR)"
    done
    [[ -f $QBX_CORE_DIR/qbx_core.sql ]] ||
        die "$QBX_CORE_DIR/qbx_core.sql is missing; qbx_core does not create its players table itself, so the qbx run imports this file first"
    [[ -f $QBX_VEHICLES_DIR/vehicles.sql ]] ||
        die "$QBX_VEHICLES_DIR/vehicles.sql is missing; qbx_vehicles reads player_vehicles, which it does not create, so the qbx run imports this file after qbx_core.sql"
    # The esx run's: es_extended and esx_lib are resources, and the SQL is one file of esx_core's.
    # Nothing here is installed by this script, so a box that lacks them is told where to put them.
    for dir in "$ESX_DIR" "$ESX_LIB_DIR"; do
        [[ -f $dir/fxmanifest.lua ]] ||
            die "$dir is not a resource checkout, and the esx run needs it; install es_extended and esx_lib from one esx_core release at ${ESX_DIR%/*} (scripts/deploy/README.md), or set ESX_DIR, ESX_LIB_DIR and ESX_SQL in $ENV_FILE"
    done
    [[ -f $ESX_SQL ]] ||
        die "$ESX_SQL is missing; es_extended does not create its tables itself, so the esx run imports esx_core's legacy.sql first (ESX_SQL in $ENV_FILE says where it is)"
fi

# Strip FXServer's colour codes so the patterns below see the words.
plain() { sed 's/\x1b\[[0-9;]*m//g'; }

report() {
    echo "---- FXServer console, ${mode_tag}mica, oxmysql and framework lines ----"
    podman logs "$fx" 2>&1 | plain | grep -iE 'mica|oxmysql|ox_lib|qbx|esx|es_extended|ox_inventory|resources\]|svadhesive|Quitting' || true
    echo "----------------------------------------------------"
}

# qbx mode's database (MICA-304). qbx_core does not create `players` at start, and micaOS reads
# it (the framework's own table, never created by micaOS), so it holds qbx_core's own schema
# before FXServer starts, imported from the resource's own file, and one character for the suite
# to look up offline. integration/lib/qbxSeed.ts names the same character, and
# server/__tests__/smokeWrapperQbx.test.ts holds the two to each other. No micaOS table: the run is
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
    podman exec -i "$db" mariadb -uroot -psmoke mica <"$QBX_CORE_DIR/qbx_core.sql" ||
        mdie "qbx_core.sql from $QBX_CORE_DIR failed to import"
    count=$(podman exec "$db" mariadb -uroot -psmoke -N -e "select count(*) from information_schema.tables where table_schema='mica' and table_name='players'")
    [[ $count == 1 ]] || mdie "qbx_core.sql imported but the database holds no players table"
    # After qbx_core's, since its player_vehicles has a foreign key onto `players`.
    podman exec -i "$db" mariadb -uroot -psmoke mica <"$QBX_VEHICLES_DIR/vehicles.sql" ||
        mdie "vehicles.sql from $QBX_VEHICLES_DIR failed to import"
    podman exec -i "$db" mariadb -uroot -psmoke mica <<<"$QBX_SEED_SQL" ||
        mdie "could not seed the qbx_core players table with the suite's character"
    count=$(podman exec "$db" mariadb -uroot -psmoke mica -N -e "select count(*) from players where citizenid='ITXQBX01'")
    [[ $count == 1 ]] || mdie "the suite's character is not in the players table after seeding it"
    count=$(podman exec "$db" mariadb -uroot -psmoke -N -e "select count(*) from information_schema.tables where table_schema='mica' and table_name like 'mica\\_%'")
    [[ $count == 0 ]] || mdie "the database holds $count micaOS table(s) before micaOS starts, so the first-start schema would prove nothing"
    echo "smoke: imported qbx_core.sql and seeded one character; the database holds no micaOS table"
}

# esx mode's database (MICA-304). es_extended does not create its tables at start, and micaOS
# reads `users` (the framework's own table, never created by micaOS), so it holds ESX Legacy's
# own schema before FXServer starts, imported from esx_core's own legacy.sql, and one character
# for the suite to look up offline. That file's `users` carries the `ssn` es_extended's own
# migrations expect (NOT NULL, unique), and the firstname, lastname and phone_number micaOS's
# offline lookups read. integration/lib/esxSeed.ts names the same character, and
# server/__tests__/smokeWrapperEsx.test.ts holds the two to each other. No micaOS table: the run is
# only a pass if micaOS creates its schema itself, beside this `users`.
read -r -d '' ESX_SEED_SQL <<'SQL' || true
INSERT INTO users (identifier, ssn, accounts, `group`, inventory, job, job_grade, loadout, metadata, `position`, firstname, lastname, dateofbirth, sex, height, phone_number)
VALUES (
    'license:itxesx01', '555-01-0456',
    '{"money":0,"bank":0,"black_money":0}', 'user', '[]', 'unemployed', 0, '[]', '{}',
    '{"x":0.0,"y":0.0,"z":0.0,"heading":0.0}',
    'Ada', 'Quill', '01/01/1990', 'f', 170, '5550100456'
);
SQL

seed_esx() {
    local count
    podman exec -i "$db" mariadb -uroot -psmoke mica <"$ESX_SQL" ||
        mdie "legacy.sql from $ESX_SQL failed to import"
    count=$(podman exec "$db" mariadb -uroot -psmoke -N -e "select count(*) from information_schema.tables where table_schema='mica' and table_name='users'")
    [[ $count == 1 ]] || mdie "legacy.sql imported but the database holds no users table"
    podman exec -i "$db" mariadb -uroot -psmoke mica <<<"$ESX_SEED_SQL" ||
        mdie "could not seed the es_extended users table with the suite's character"
    count=$(podman exec "$db" mariadb -uroot -psmoke mica -N -e "select count(*) from users where identifier='license:itxesx01'")
    [[ $count == 1 ]] || mdie "the suite's character is not in the users table after seeding it"
    count=$(podman exec "$db" mariadb -uroot -psmoke -N -e "select count(*) from information_schema.tables where table_schema='mica' and table_name like 'mica\\_%'")
    [[ $count == 0 ]] || mdie "the database holds $count micaOS table(s) before micaOS starts, so the first-start schema would prove nothing"
    echo "smoke: imported legacy.sql and seeded one character; the database holds no micaOS table"
}

# One FXServer, start to verdict, against a database of its own. $1 is the run: `release` (the
# zip's own mica.esx.sql imported, mica started, the console left clean), or one of the three
# integration runs, `standalone`, `qbx` and `esx`. A run that fails ends the invocation, naming
# itself.
run_mode() {
    local mode=$1 id sd mounts start_timeout deadline started logs running results tables
    local npass nfail nskip ndone want_pass want_skip got_pass got_skip created_re bridge_re bridge_name up
    id=${stage##*/run.}
    mode_tag=''
    [[ $mode == release ]] || mode_tag="[$mode mode] "
    net="mica-smoke-$mode-$id"
    db="mica-smoke-db-$mode-$id"
    fx="mica-smoke-fx-$mode-$id"

    podman network create "$net" >/dev/null

    case $mode in
        release) echo "smoke: starting $DB_IMAGE and importing the zip's mica.esx.sql" ;;
        standalone) echo "smoke: ${mode_tag}starting $DB_IMAGE, EMPTY: micaOS creates the schema itself on its first start" ;;
        qbx) echo "smoke: ${mode_tag}starting $DB_IMAGE with qbx_core's players table and a character in it; micaOS creates its own schema on its first start" ;;
        esx) echo "smoke: ${mode_tag}starting $DB_IMAGE with ESX Legacy's tables and a character in its users table; micaOS creates its own schema on its first start" ;;
    esac
    podman run -d --name "$db" --network "$net" \
        -e MARIADB_ROOT_PASSWORD=smoke -e MARIADB_DATABASE=mica \
        "$DB_IMAGE" >/dev/null
    # An authenticated query over TCP, not a ping and not the socket. The image's first-boot init
    # runs a temporary server with --skip-networking: it answers ping before the root password
    # exists, and an import sent to that one is refused with "Access denied". Once the password
    # is set it answers a login for a few tens of milliseconds and stops, and there is no server
    # at all, one to two seconds, until the real one is ready for connections. A probe on the
    # socket can pass against the temporary server and the next call meets the gap, which is how
    # Release runs 39293409481 and 39294099614 died 5.7s after the database container started. Only the real server
    # listens on TCP, and once it does the socket is its too, so the imports below may use either.
    ready() { podman exec "$db" mariadb -uroot -psmoke -h127.0.0.1 --protocol=tcp -e 'select 1' >/dev/null 2>&1; }
    # The verdict is recorded in the loop and read after it: a second probe to decide would be
    # a second roll of the dice, free to contradict a check that already passed.
    up=0
    for _ in $(seq 1 90); do
        if ready; then
            up=1
            break
        fi
        nap 1
    done
    [[ $up == 1 ]] || mdie "$DB_IMAGE did not accept a root login within 90s"
    # The release smoke test's import is itself half the test: the file an owner may import by
    # hand has to import. Standalone mode wants the ESX file: mica.sql reads qb's players table
    # first and fails without it, and this database has none. The standalone integration run
    # leaves the database empty, for micaOS to create (MICA-306): importing here would make the
    # first start a no-op. The qbx and esx runs hold the framework's own tables and no micaOS one.
    case $mode in
        release)
            podman exec -i "$db" mariadb -uroot -psmoke mica <"$resource/mica.esx.sql" ||
                mdie "mica.esx.sql from the zip failed to import"
            tables=$(podman exec "$db" mariadb -uroot -psmoke -N -e "select count(*) from information_schema.tables where table_schema='mica'")
            echo "smoke: imported mica.esx.sql -- $tables tables"
            ;;
        standalone)
            tables=$(podman exec "$db" mariadb -uroot -psmoke -N -e "select count(*) from information_schema.tables where table_schema='mica'")
            [[ $tables == 0 ]] || mdie "the database is not empty before micaOS starts ($tables tables), so the first-start schema would prove nothing"
            echo "smoke: the database holds no table; nothing imported"
            ;;
        qbx) seed_qbx ;;
        esx) seed_esx ;;
    esac

    # A server-data of its own: the config below, and whatever FXServer writes beside it (its
    # cache). Everything in it is made here, in this run's staging directory, by the uid the
    # container runs as, so FXServer can write there and nowhere else on the host. Noclobber on
    # every file: a name already there is an error.
    sd="$stage/sd-$mode"
    mkdir "$sd" "$sd/resources" "$sd/resources/oxmysql" "$sd/resources/mica"
    case $mode in
        qbx) mkdir "$sd/resources/ox_lib" "$sd/resources/qbx_core" "$sd/resources/qbx_vehicles" "$sd/resources/ox_inventory" ;;
        esx) mkdir "$sd/resources/ox_lib" "$sd/resources/esx_lib" "$sd/resources/es_extended" "$sd/resources/ox_inventory" ;;
    esac
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
        elif [[ $mode == esx ]]; then
            # es_extended starts on onesync, and turns itself onto ox_inventory (its
            # `Config.CustomInventory`) because ox_inventory's folder is there, which ox_inventory's
            # esx bridge then checks. No `mica_standalone`, for the reason the qbx run gives. The
            # rest is the qbx run's: no version-check call, and the item that makes micaOS register
            # the phone as usable.
            echo 'set onesync on'
            echo 'setr inventory:framework "esx"'
            echo 'set inventory:versioncheck "false"'
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
        case $mode in
            qbx) printf 'ensure %s\n' ox_lib qbx_core qbx_vehicles ox_inventory ;;
            # esx_lib before es_extended, whose manifest loads it; es_extended before ox_inventory,
            # whose esx bridge asks it for its shared object half a second after it starts.
            esx) printf 'ensure %s\n' ox_lib esx_lib es_extended ox_inventory ;;
        esac
        echo 'ensure mica'
        [[ $integration != 1 ]] || echo 'ensure mica-integration'
    } >"$sd/server.cfg"
    set +C
    chmod 600 "$sd/server.cfg"

    echo "smoke: ${mode_tag}starting $FX_IMAGE with the zip's mica and $OXMYSQL_DIR"
    # `-w`: the image's entrypoint renders server.cfg from a template only when none
    # exists in its working directory, then execs run.sh there. `+exec` is what the
    # stack's own units deliberately never pass (it would skip txAdmin's wizard);
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
    if [[ $mode == esx ]]; then
        echo "smoke: ${mode_tag}mounting $OX_LIB_DIR, $ESX_LIB_DIR, $ESX_DIR and $OX_INVENTORY_DIR read-only, and ensuring them before mica"
        mounts+=(
            -v "$OX_LIB_DIR:/opt/fivem/server-data/resources/ox_lib:ro"
            -v "$ESX_LIB_DIR:/opt/fivem/server-data/resources/esx_lib:ro"
            -v "$ESX_DIR:/opt/fivem/server-data/resources/es_extended:ro"
            -v "$OX_INVENTORY_DIR:/opt/fivem/server-data/resources/ox_inventory:ro"
        )
    fi
    if [[ $integration == 1 ]]; then
        echo "smoke: ${mode_tag}INTEGRATION -- mica-integration is in the zip; mounting it and ensuring it after mica"
        mounts+=(-v "$integ:/opt/fivem/server-data/resources/mica-integration:ro")
    fi
    # `--userns=keep-id`: this account's uid is the same number inside the container, so
    # FXServer runs as the owner of the staged server-data and can write its cache there.
    # `--log-driver k8s-file`: everything below reads the console with `podman logs`, and under
    # the default journald driver a system account's container logs land in the system journal,
    # which the account cannot read back -- `podman logs` comes back empty, and mica is never
    # seen to start.
    podman run -d -i --name "$fx" --network "$net" --userns=keep-id --user "$owner" \
        --log-driver k8s-file \
        -w /opt/fivem/server-data \
        "${mounts[@]}" \
        "$FX_IMAGE" +exec server.cfg >/dev/null

    # The qbx and esx stacks load four resources micaOS does not, and qbx_core alone is hundreds
    # of files.
    start_timeout=$START_TIMEOUT
    [[ $mode == release || $mode == standalone ]] || start_timeout=$((START_TIMEOUT + 60))
    started=0
    deadline=$(($(clock_now) + start_timeout))
    while (($(clock_now) < deadline)); do
        logs=$(podman logs "$fx" 2>&1 | plain || true)
        if grep -q 'mica started!' <<<"$logs"; then
            started=1
            break
        fi
        if grep -qiE "Couldn't find resource mica|Failed to (load|start) resource mica|Could not (load|start) resource mica" <<<"$logs"; then
            break
        fi
        if [[ $(podman inspect -f '{{.State.Running}}' "$fx" 2>/dev/null) != true ]]; then
            break
        fi
        nap 2
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
        deadline=$(($(clock_now) + INTEGRATION_TIMEOUT))
        while :; do
            running=$(podman inspect -f '{{.State.Running}}' "$fx" 2>/dev/null || true)
            logs=$(podman logs "$fx" 2>&1 | plain || true)
            grep -qE "$done_re" <<<"$logs" && break
            [[ $running == true ]] || break
            (($(clock_now) < deadline)) || break
            nap 2
        done
    else
        nap "$SETTLE_SECONDS"
        logs=$(podman logs "$fx" 2>&1 | plain || true)
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
        # And micaOS's bridge took the framework this run started, not another or nothing
        # (MICA-227's line, which names what answered for jobs). The suite starts too late to hear
        # it. The esx run needs it most: the schema line is the same words standalone prints, since
        # ESX and standalone share a width, so only this line says micaOS detected es_extended.
        case $mode in
            qbx)
                created_re="created micaOS's schema for qbx/qb"
                bridge_re='mica: jobs -> qbx_core '
                bridge_name=qbx_core
                ;;
            esx)
                created_re="created micaOS's schema for ESX or standalone"
                bridge_re='mica: jobs -> es_extended '
                bridge_name=es_extended
                ;;
            *)
                created_re="created micaOS's schema for ESX or standalone"
                bridge_re=''
                bridge_name=''
                ;;
        esac
        if ! grep -qF "$created_re" <<<"$logs"; then
            echo "---- micaOS's schema lines ----" >&2
            grep -iE "\[mica\].*(schema|half-created|database)" <<<"$logs" >&2 || true
            mdie "the console never said micaOS created its schema (\"$created_re ...\") on a database holding none of its own; the first-start schema is unproven"
        fi
        if [[ -n $bridge_re ]] && ! grep -qF "$bridge_re" <<<"$logs"; then
            echo "---- micaOS's bridge lines ----" >&2
            grep -iE 'mica: (jobs|banking)|FrameworkBridge' <<<"$logs" >&2 || true
            mdie "the console never said micaOS's bridge took $bridge_name (\"$bridge_re...\"); micaOS did not detect the framework it was started beside"
        fi
        if [[ $mode != standalone ]] && grep -qF 'mica_standalone is set, but' <<<"$logs"; then
            mdie "micaOS reported mica_standalone set beside the framework; the $mode run must leave it out"
        fi
        # The verdict lines are the suite's own and can say anything; what follows is for what
        # the console says about everything else.
        logs=$(grep -vE 'integration: (PASS|FAIL|SKIP|done|mode) ' <<<"$logs" || true)
    elif [[ $(podman inspect -f '{{.State.Running}}' "$fx" 2>/dev/null) != true ]]; then
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
    echo "smoke: integration passed in every run -- ${ran[0]}; ${ran[1]}; ${ran[2]}"
fi
completed=1
