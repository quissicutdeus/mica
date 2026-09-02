#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 quissicutdeus
#
# SPDX-License-Identifier: AGPL-3.0-or-later

# Root-owned smoke-test wrapper (MICA-220). gphone can only invoke this exact
# script via sudoers; it cannot edit it. It takes one argument, a run directory
# that ~gphone/bin/smoke-release.sh has just unpacked a release zip into, and
# proves the zip is a resource FXServer can start: a throwaway MariaDB gets the
# zip's own gphone.esx.sql imported, a throwaway FXServer from the stack's own
# image gets the zip's gphone mounted read-only beside the stack's oxmysql, and
# the console has to say `gphone started!` with no error from gphone or oxmysql
# after it. Everything it starts is torn down on exit, whichever way it exits.
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
# resource and then quits, which proves the zip loads but not that gphone
# reaches its database. A key registered for this box, and NOT the one either
# live stack uses -- two servers on one key will not both stay up -- is what
# makes the second half provable. MICA_SMOKE_KEYLESS=1 runs without one and
# says so on every line it prints; it exists for trying this script by hand.
set -euo pipefail

SMOKE_ROOT=/home/gphone/smoke
ENV_FILE=/etc/gphone-smoke.env

# Overridable from ENV_FILE. The defaults are the stack as scripts/deploy/README.md
# describes it: compose project `fivem`, so the image is `fivem-server`, and the
# main checkout's oxmysql, which the live main server already runs.
FX_IMAGE=fivem-server:latest
DB_IMAGE=mariadb:noble
OXMYSQL_DIR=/opt/fivem-main/server-data/vendor/oxmysql
LICENSE_KEY=

# How long FXServer gets to print `gphone started!`, and how long the server is
# then left running for gphone's asynchronous start -- the oxmysql connection,
# the schema report, the orphan sweep's refusal on standalone -- to say anything.
START_TIMEOUT=180
SETTLE_SECONDS=20

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
if [[ -n $(find "$real" -type l -print -quit) ]]; then
    die "$real contains a symlink; the zip this repo ships carries none"
fi
resource="$real/resources/gphone"
[[ -f $resource/fxmanifest.lua ]] || die "$resource/fxmanifest.lua is missing"
[[ -f $resource/gphone.esx.sql ]] || die "$resource/gphone.esx.sql is missing"
owner=$(stat -c '%u:%g' "$real")

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

id=$(basename "$real")
net="gphone-smoke-$id"
db="gphone-smoke-db-$id"
fx="gphone-smoke-fx-$id"

teardown() {
    docker rm -f "$fx" "$db" >/dev/null 2>&1 || true
    docker network rm "$net" >/dev/null 2>&1 || true
}
trap teardown EXIT

# Strip FXServer's colour codes so the patterns below see the words.
plain() { sed 's/\x1b\[[0-9;]*m//g'; }

docker network create "$net" >/dev/null

echo "smoke: starting $DB_IMAGE and importing the zip's gphone.esx.sql"
docker run -d --name "$db" --network "$net" \
    -e MARIADB_ROOT_PASSWORD=smoke -e MARIADB_DATABASE=gphone \
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
# The import is itself half the test: the file an owner is told to import has to
# import. Standalone mode wants the ESX file, which carries no foreign key onto a
# framework table that this database does not have.
docker exec -i "$db" mariadb -uroot -psmoke gphone <"$resource/gphone.esx.sql" ||
    die "gphone.esx.sql from the zip failed to import"
tables=$(docker exec "$db" mariadb -uroot -psmoke -N -e "select count(*) from information_schema.tables where table_schema='gphone'")
echo "smoke: imported gphone.esx.sql -- $tables tables"

# A server-data of its own: the config below, and whatever FXServer writes
# beside it (its cache). Owned by the run directory's owner, which is the uid the
# container runs as, so it can write there and nowhere else.
sd="$real/server-data"
mkdir -p "$sd/resources/oxmysql" "$sd/resources/gphone"
{
    echo 'endpoint_add_tcp "0.0.0.0:30120"'
    echo 'endpoint_add_udp "0.0.0.0:30120"'
    echo 'set sv_hostname "gphone release smoke"'
    echo 'set sv_maxclients 1'
    [[ $keyless == 1 ]] || echo "set sv_licenseKey \"$LICENSE_KEY\""
    echo 'set mysql_connection_string "mysql://root:smoke@'"$db"':3306/gphone?charset=utf8mb4"'
    echo 'set gphone_standalone 1'
    echo 'ensure oxmysql'
    echo 'ensure gphone'
} >"$sd/server.cfg"
chmod 600 "$sd/server.cfg"
chown -R "$owner" "$sd"

echo "smoke: starting $FX_IMAGE with the zip's gphone and $OXMYSQL_DIR"
# `-w`: the image's entrypoint renders server.cfg from a template only when none
# exists in its working directory, then execs run.sh there. `+exec` is what the
# stack's own compose deliberately never passes (it would skip txAdmin's wizard);
# here there is no txAdmin and skipping it is the point.
docker run -d --name "$fx" --network "$net" --user "$owner" \
    -w /opt/fivem/server-data \
    -v "$sd:/opt/fivem/server-data" \
    -v "$OXMYSQL_DIR:/opt/fivem/server-data/resources/oxmysql:ro" \
    -v "$resource:/opt/fivem/server-data/resources/gphone:ro" \
    "$FX_IMAGE" +exec server.cfg >/dev/null

started=0
deadline=$((SECONDS + START_TIMEOUT))
while ((SECONDS < deadline)); do
    logs=$(docker logs "$fx" 2>&1 | plain || true)
    if grep -q 'gphone started!' <<<"$logs"; then
        started=1
        break
    fi
    if grep -qiE "Couldn't find resource gphone|Failed to (load|start) resource gphone|Could not (load|start) resource gphone" <<<"$logs"; then
        break
    fi
    if [[ $(docker inspect -f '{{.State.Running}}' "$fx" 2>/dev/null) != true ]]; then
        break
    fi
    sleep 2
done

report() {
    echo "---- FXServer console, gphone and oxmysql lines ----"
    docker logs "$fx" 2>&1 | plain | grep -iE 'gphone|oxmysql|resources\]|svadhesive|Quitting' || true
    echo "----------------------------------------------------"
}

if [[ $started != 1 ]]; then
    report
    die "FXServer never printed 'gphone started!' within ${START_TIMEOUT}s -- the zip does not start as a resource"
fi

if [[ $keyless == 1 ]]; then
    report
    echo "smoke: KEYLESS -- gphone started; FXServer quits without a key, so its database start is NOT proven"
    exit 0
fi

# The keyed half. The server stays up, so gphone's asynchronous start gets a
# fixed window to complain in, and then the console is read for the things that
# would make a released zip a bad one: a script error from gphone, or oxmysql
# failing to connect to a database that was imported seconds ago.
sleep "$SETTLE_SECONDS"
logs=$(docker logs "$fx" 2>&1 | plain || true)
report
if [[ $(docker inspect -f '{{.State.Running}}' "$fx" 2>/dev/null) != true ]]; then
    die "FXServer exited after gphone started; with a key it should stay up (a key already in use elsewhere does this)"
fi
if grep -iE 'script:gphone' <<<"$logs" | grep -qiE 'error|exception|unhandled'; then
    die "gphone logged an error after starting"
fi
if grep -iE 'oxmysql' <<<"$logs" | grep -qiE 'error|refused|denied|unable to (connect|establish)'; then
    die "oxmysql could not reach the database gphone.esx.sql was imported into"
fi
echo "smoke: gphone started against gphone.esx.sql and stayed clean for ${SETTLE_SECONDS}s"
