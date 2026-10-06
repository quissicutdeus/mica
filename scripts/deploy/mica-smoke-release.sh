#!/usr/bin/env bash

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
# within INTEGRATION_TIMEOUT, every `integration: PASS|FAIL <id>` line is echoed here
# for the CI log, and any FAIL, a missing done line, a done line that disagrees with the
# lines it summarises, or a suite that ran nothing is a non-zero exit. A release zip
# never holds that directory (scripts/pack-resource.js refuses to write one that does),
# so the release smoke test cannot drift into this mode. Whatever the mode, a second
# invocation waits for the first: two servers on one licence key will not both stay up.
#
# Nothing the deploy account writes is trusted once it is read. It owns the run directory
# and runs pushed code, so any name there can be a symlink by the time root gets to it;
# root copies resources/ out without following links into a staging directory under a
# root-owned parent, checks the copy, and builds, mounts and chowns only there.
set -euo pipefail

# Identity line, first thing, so CI can tell which copy of this script hoth is really running.
# This file is root-owned and installed by hand (scripts/deploy/README.md), which means a change
# to the repo's copy reaches the box only when a person reinstalls it, and nothing says so when
# they do not. scripts/deploy/check-wrapper-identity.sh, called by every CI job that reaches
# this script, compares this hash with the checked-out copy's and fails the job on a difference
# or on no line at all. The name is $0's, and the line precedes every guard below, so a run
# that is refused further down still says what ran. Keep the format: that script parses it.
self_sha=$(sha256sum -- "$0" | cut -d' ' -f1)
echo "mica-wrapper: ${0##*/} sha256 $self_sha"

SMOKE_ROOT=/home/gphone/smoke
ENV_FILE=/etc/mica-smoke.env

# Overridable from ENV_FILE. The defaults are the stack as scripts/deploy/README.md
# describes it: compose project `fivem`, so the image is `fivem-server`, and the
# main checkout's oxmysql, which the live main server already runs.
FX_IMAGE=fivem-server:latest
DB_IMAGE=mariadb:noble
OXMYSQL_DIR=/opt/fivem-main/server-data/vendor/oxmysql
LICENSE_KEY=

# How long FXServer gets to print `mica started!`, and how long the server is
# then left running for mica's asynchronous start -- the oxmysql connection,
# the schema report, the orphan sweep's refusal on standalone -- to say anything.
START_TIMEOUT=180
SETTLE_SECONDS=20
# Integration mode only: how long after `mica started!` the suite has to finish. And, in
# either mode, how long a run waits for another to release the box before giving up.
INTEGRATION_TIMEOUT=300
LOCK_TIMEOUT=1500
# Root-owned places only: the lock, and the staging directories each run is built in. Neither
# is under the deploy account's home, which is the point of both.
LOCK_FILE=/run/mica-smoke.lock
STAGE_ROOT=/var/lib/mica-smoke
KEY_DIR=mica-keys
KEY_NAME=mica-content.key

die() {
    echo "REFUSED: $*" >&2
    exit 1
}

# A trial by an ordinary user may point SMOKE_ROOT and ENV_FILE elsewhere. Under
# sudo this runs as root, and root ignores both: sudoers does not pass them and
# the trust root of a privileged script is not something its caller chooses.
if [[ $(id -u) -ne 0 ]]; then
    SMOKE_ROOT=${MICA_SMOKE_ROOT:-$SMOKE_ROOT}
    ENV_FILE=${MICA_SMOKE_ENV:-$ENV_FILE}
    # So server/__tests__/smokeWrapper.test.ts can reach the timeout paths in seconds.
    SETTLE_SECONDS=${MICA_SMOKE_SETTLE:-$SETTLE_SECONDS}
    INTEGRATION_TIMEOUT=${MICA_SMOKE_INTEGRATION_TIMEOUT:-$INTEGRATION_TIMEOUT}
    LOCK_FILE=${MICA_SMOKE_LOCK:-${TMPDIR:-/tmp}/mica-smoke-$(id -u).lock}
    STAGE_ROOT=${MICA_SMOKE_STAGE:-${TMPDIR:-/tmp}/mica-smoke-stage-$(id -u)}
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
    for key in LICENSE_KEY FX_IMAGE DB_IMAGE OXMYSQL_DIR; do
        value=$(grep -m1 "^${key}=" "$ENV_FILE" | cut -d= -f2- || true)
        [[ -n $value ]] && printf -v "$key" '%s' "$value"
    done
fi

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

docker image inspect "$FX_IMAGE" >/dev/null 2>&1 ||
    die "no docker image $FX_IMAGE; set FX_IMAGE in $ENV_FILE to the stack's FXServer image (docker images | grep server)"
[[ -f $OXMYSQL_DIR/fxmanifest.lua ]] ||
    die "$OXMYSQL_DIR is not an oxmysql checkout; set OXMYSQL_DIR in $ENV_FILE"

# One run at a time, and the lock is the first thing taken. The key below is registered for
# one server, so a second run starting while the first is up would fail on the licence
# rather than on its own merits -- and nothing the deploy account writes may be read or
# trusted before this, because waiting here can take as long as another run does. The lock
# file is in a directory only root can write; a file in the deploy account's own tree is
# one it could hold forever or move.
command -v flock >/dev/null || die "flock is not installed; runs cannot be serialised"
exec 9>>"$LOCK_FILE"
flock -w "$LOCK_TIMEOUT" 9 || die "another smoke run held the box for ${LOCK_TIMEOUT}s"

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
if [[ $(id -u) -eq 0 ]]; then
    install -d -m 755 -o root -g root "$STAGE_ROOT"
else
    install -d -m 755 "$STAGE_ROOT"
fi
[[ -d $STAGE_ROOT && ! -L $STAGE_ROOT && $(stat -c %u "$STAGE_ROOT") -eq $(id -u) ]] ||
    die "$STAGE_ROOT is not a directory of this user's own"

stage=
net=
db=
fx=
teardown() {
    if [[ -n $fx ]]; then
        docker rm -f "$fx" "$db" >/dev/null 2>&1 || true
        docker network rm "$net" >/dev/null 2>&1 || true
    fi
    # The copy of the zip, server-data, FXServer's cache and the keyring: nothing of a run
    # outlives it.
    [[ -z $stage ]] || rm -rf -- "$stage"
}
trap teardown EXIT

stage=$(mktemp -d "$STAGE_ROOT/run.XXXXXXXX")
chmod 755 "$stage"
id=${stage##*/run.}
net="mica-smoke-$id"
db="mica-smoke-db-$id"
fx="mica-smoke-fx-$id"

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
if [[ -e $integ ]]; then
    integration=1
    [[ -f $integ/fxmanifest.lua ]] || die "mica-integration/fxmanifest.lua is missing from the zip"
    [[ -f $integ/expected-scenarios.txt ]] ||
        die "mica-integration/expected-scenarios.txt is missing; without it a dropped scenario could not be told from a passed run"
    [[ -s $integ/expected-scenarios.txt ]] || die "mica-integration/expected-scenarios.txt is empty"
    if grep -qvE '^[a-z0-9][a-z0-9-]*$' "$integ/expected-scenarios.txt"; then
        die "mica-integration/expected-scenarios.txt holds a line that is not a scenario id"
    fi
fi

# Strip FXServer's colour codes so the patterns below see the words.
plain() { sed 's/\x1b\[[0-9;]*m//g'; }

docker network create "$net" >/dev/null

if [[ $integration == 1 ]]; then
    echo "smoke: starting $DB_IMAGE, EMPTY: micaOS creates the schema itself on its first start"
else
    echo "smoke: starting $DB_IMAGE and importing the zip's mica.esx.sql"
fi
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
ready || die "$DB_IMAGE did not accept a root login within 90s"
# The release smoke test's import is itself half the test: the file an owner may import by hand
# has to import. Standalone mode wants the ESX file: mica.sql reads qb's players table first and
# fails without it, and this database has none. The integration run leaves the database empty,
# for micaOS to create (MICA-306): importing here would make the first start a no-op.
if [[ $integration == 1 ]]; then
    tables=$(docker exec "$db" mariadb -uroot -psmoke -N -e "select count(*) from information_schema.tables where table_schema='mica'")
    [[ $tables == 0 ]] || die "the database is not empty before micaOS starts ($tables tables), so the first-start schema would prove nothing"
    echo "smoke: the database holds no table; nothing imported"
else
    docker exec -i "$db" mariadb -uroot -psmoke mica <"$resource/mica.esx.sql" ||
        die "mica.esx.sql from the zip failed to import"
    tables=$(docker exec "$db" mariadb -uroot -psmoke -N -e "select count(*) from information_schema.tables where table_schema='mica'")
    echo "smoke: imported mica.esx.sql -- $tables tables"
fi

# A server-data of its own: the config below, and whatever FXServer writes beside it (its
# cache). Everything in it is made here, by root, in a directory nothing else can write, and
# only then handed to the run directory's owner -- the uid the container runs as -- so it can
# write there and nowhere else. Noclobber on every file: a name already there is an error.
sd="$stage/sd"
mkdir "$sd" "$sd/resources" "$sd/resources/oxmysql" "$sd/resources/mica"
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
    echo 'set mica_standalone 1'
    if [[ $integration == 1 ]]; then
        echo "set mica_content_key_file \"/opt/fivem/server-data/resources/$KEY_DIR/$KEY_NAME\""
        echo 'set mica_integration "1"'
        # What the suite reads to know micaOS, not an import, made the schema it is run
        # against. A wrapper that predates MICA-306 sets nothing, and the suite fails on that.
        echo 'set mica_integration_schema "bootstrap"'
    fi
    echo 'ensure oxmysql'
    echo 'ensure mica'
    [[ $integration != 1 ]] || echo 'ensure mica-integration'
} >"$sd/server.cfg"
set +C
chmod 600 "$sd/server.cfg"
chown -R "$owner" "$sd"

echo "smoke: starting $FX_IMAGE with the zip's mica and $OXMYSQL_DIR"
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
if [[ $integration == 1 ]]; then
    echo "smoke: INTEGRATION -- mica-integration is in the zip; mounting it and ensuring it after mica"
    mounts+=(-v "$integ:/opt/fivem/server-data/resources/mica-integration:ro")
fi
docker run -d -i --name "$fx" --network "$net" --user "$owner" \
    -w /opt/fivem/server-data \
    "${mounts[@]}" \
    "$FX_IMAGE" +exec server.cfg >/dev/null

started=0
deadline=$((SECONDS + START_TIMEOUT))
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

report() {
    echo "---- FXServer console, mica and oxmysql lines ----"
    docker logs "$fx" 2>&1 | plain | grep -iE 'mica|oxmysql|resources\]|svadhesive|Quitting' || true
    echo "----------------------------------------------------"
}

if [[ $started != 1 ]]; then
    report
    die "FXServer never printed 'mica started!' within ${START_TIMEOUT}s -- the zip does not start as a resource"
fi

if [[ $keyless == 1 && $integration != 1 ]]; then
    report
    echo "smoke: KEYLESS -- mica started; FXServer quits without a key, so its database start is NOT proven"
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
done_re='integration: done ([0-9]+) passed ([0-9]+) failed'
if [[ $integration == 1 ]]; then
    echo "smoke: INTEGRATION -- waiting up to ${INTEGRATION_TIMEOUT}s for the suite's done line"
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
    results=$(grep -oE 'integration: (PASS|FAIL|done) .*' <<<"$logs" || true)
    echo "---- integration results ----"
    echo "$results"
    echo "-----------------------------"
    npass=$(grep -c '^integration: PASS ' <<<"$results" || true)
    nfail=$(grep -c '^integration: FAIL ' <<<"$results" || true)
    ndone=$(grep -cE "^$done_re" <<<"$results" || true)
    ((nfail == 0)) || die "$nfail integration scenario(s) FAILED; the FAIL lines are above"
    if ((ndone == 0)); then
        if [[ $running == true ]]; then
            die "no 'integration: done' line within ${INTEGRATION_TIMEOUT}s of 'mica started!'; the suite hung or never ran"
        fi
        die "FXServer stopped before the suite printed 'integration: done'; its last console lines are above"
    fi
    ((ndone == 1)) || die "the suite printed 'integration: done' $ndone times"
    [[ $(grep -E "^$done_re" <<<"$results") =~ $done_re ]]
    if ((BASH_REMATCH[1] != npass || BASH_REMATCH[2] != nfail)); then
        die "the done line says ${BASH_REMATCH[1]} passed ${BASH_REMATCH[2]} failed but the console holds $npass PASS and $nfail FAIL lines"
    fi
    ((npass > 0)) || die "the suite finished having run no scenario; that is not a pass"
    # Exactly the scenarios the zip was packed to carry. A group dropped from the suite's
    # index still prints a clean done line, so the count it reports is only as good as the
    # list it was counted from, which pack-integration.js wrote from the source tree.
    got=$(grep '^integration: PASS ' <<<"$results" | sed -E 's/^integration: PASS ([^ ]+).*/\1/' | sort)
    want=$(sort "$integ/expected-scenarios.txt")
    if [[ $got != "$want" ]]; then
        echo "---- expected scenarios (<) against the PASS lines (>) ----" >&2
        diff <(echo "$want") <(echo "$got") >&2 || true
        die "the PASS lines are not the scenarios this zip was packed with"
    fi
    # MICA-306: the database was empty, so every table the suite ran against was made by
    # micaOS's own first start, and the console says so exactly once, from micaOS. The suite
    # reads the tables and the ledger back; only the whole console holds this line, since the
    # suite's own listener starts after micaOS has begun talking. A refusal prints the reason
    # instead, and the lines that say why are shown.
    created_re="created micaOS's schema for"
    if ! grep -qF "$created_re" <<<"$logs"; then
        echo "---- micaOS's schema lines ----" >&2
        grep -iE "\[mica\].*(schema|half-created|database)" <<<"$logs" >&2 || true
        die "the console never said micaOS created its schema (\"$created_re ...\") on an empty database; the first-start schema is unproven"
    fi
    # The verdict lines are the suite's own and can say anything; what follows is for what
    # the console says about everything else.
    logs=$(grep -vE 'integration: (PASS|FAIL|done) ' <<<"$logs" || true)
elif [[ $(docker inspect -f '{{.State.Running}}' "$fx" 2>/dev/null) != true ]]; then
    die "FXServer exited after mica started; with a key it should stay up. Its last console lines above say why: 'Quitting: Ctrl-C' is stdin closing, a licence error is the key, and a key already in use on another server also ends it"
fi
if [[ $integration == 1 ]]; then
    # The suite provokes micaOS's refusals on purpose and some print the word "Error" on
    # mica's own channel (`keygen refused: ... (Error: EACCES ...)`), so a line that merely
    # contains it says nothing. What does is the shape FXServer gives a resource that is
    # broken: a SCRIPT ERROR, an unhandled rejection or uncaught exception, a Lua stack
    # traceback, a resource that did not start. Behaviour is the scenarios' verdict.
    broken='SCRIPT ERROR|unhandled.?(promise)?.?rejection|uncaught (exception|error)|stack traceback|(failed|could not|couldn.t) (to )?(load|start) resource'
    if grep -qiE "$broken" <<<"$logs"; then
        echo "---- lines that look like a broken resource ----" >&2
        grep -iE "$broken" <<<"$logs" >&2 || true
        die "a resource failed or raised a script error while the suite ran"
    fi
elif grep -iE 'script:mica' <<<"$logs" | grep -qiE 'error|exception|unhandled'; then
    die "mica logged an error after starting"
fi
if grep -iE 'oxmysql' <<<"$logs" | grep -qiE 'error|refused|denied|unable to (connect|establish)'; then
    die "oxmysql could not reach the database it was started against"
fi
if [[ $integration == 1 ]]; then
    [[ $keyless != 1 ]] || echo "smoke: KEYLESS -- the console above is all this run could prove"
    echo "smoke: integration suite passed -- $npass scenarios, and the console stayed clean"
else
    echo "smoke: mica started against mica.esx.sql and stayed clean for ${SETTLE_SECONDS}s"
fi
