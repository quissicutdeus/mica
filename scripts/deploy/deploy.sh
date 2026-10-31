#!/bin/sh

# SPDX-FileCopyrightText: 2026 quissicutdeus
#
# SPDX-License-Identifier: AGPL-3.0-or-later

# Deploys one target, dev or main, on hoth. Runs as the fivem account, which owns
# /opt/fivem-<target> and runs every container there rootless, installed as
# ~/bin/mica-deploy.sh and pinned by that account's authorized_keys as a forced
# command whose argument is the target:
#
#   command="/home/fivem/bin/mica-deploy.sh dev",no-port-forwarding,no-X11-forwarding,\
#   no-agent-forwarding,no-pty ssh-ed25519 AAAA... mica-ci-deploy-dev
#
# .github/workflows/deploy.yml opens an SSH session with that key and sends
# nothing; sshd runs this instead, so the key, not the session, picks the target.
# What it does, in order: the micaOS resource (fetch, reset, install, build), the
# demo site's image and its Quadlet unit, a restart of the demo container, and a
# reload of the resource on the target's FiveM server over RCON. See
# scripts/deploy/README.md.
set -eu
umask 002

die() {
    echo "mica-deploy: $*" >&2
    exit 1
}

target=${1:-}
case $target in
    dev) rcon_port=30121 ;;
    main) rcon_port=30120 ;;
    *) die "usage: $0 dev|main (the forced command names the target; got '$target')" ;;
esac

# systemctl --user and rootless podman find this account's manager and store through it, and
# an SSH session with no PAM login may not have it set.
XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export XDG_RUNTIME_DIR

# One job at a time on hoth, whatever started it, and shared with the smoke and integration
# runs (mica-smoke-release.sh takes the same file). Everything below operates on a single
# working tree: it git-resets it, reinstalls its node_modules and rebuilds its dist. Two of
# these at once is two `git reset --hard` in one checkout and two `pnpm install` writing one
# `node_modules` -- and it has happened, twice concurrently for ~2.5 minutes on 2026-08-27,
# with both runs reporting success. A deploy rebuilding an image under a smoke run that is
# about to start a container from it is how an integration run died on 2026-10-06 (MICA-315).
#
# `-w 1800`, not `-n`: a deploy that arrives mid-run should land after it, not be dropped.
# Thirty minutes is far past a normal run and short of hanging forever. Created 0644: the
# smoke wrapper refuses a lock file that is writable by group or others.
lock=$XDG_RUNTIME_DIR/mica-hoth.lock
[ ! -L "$lock" ] || die "$lock is a symlink; it must be a plain file of this account's own"
(
    umask 022
    : >>"$lock"
)
exec 9>>"$lock"
flock -w 1800 9 || die "another job has held $lock for 30 minutes; refusing to pile on"
# The holder line, which a job waiting behind this one prints; emptied on the way out.
printf '%s\n' "mica-deploy.sh $target pid $$ since $(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$lock"
trap ': >"$lock"' EXIT

cd "/opt/fivem-$target/server-data/vendor/mica"

# Over SSH with the read-only deploy key that ~/.ssh/config names github-mica.
git fetch git@github-mica:quissicutdeus/mica.git "$target"
git reset --hard FETCH_HEAD

# Re-install this script from the checkout it just reset, so a change to it reaches hoth with
# the next deploy and nobody has to copy it there by hand: on 2026-08-27 exactly that drift
# left a deploy fix unapplied across two failed runs. rename(2) rather than a copy in place: a
# shell reads a script as it runs it, so overwriting this file mid-run would corrupt whatever
# it has not read yet. The new version therefore takes effect on the NEXT deploy, not this one.
#
# The dev deploy also installs the two smoke scripts the release and integration workflows
# reach, for the same reason. Only dev: they are one copy on the box, and main is behind dev.
reinstall() { # SOURCE NAME
    install -m 755 "$1" "$HOME/bin/.$2.new"
    mv -f "$HOME/bin/.$2.new" "$HOME/bin/$2"
}
reinstall scripts/deploy/deploy.sh mica-deploy.sh
if [ "$target" = dev ]; then
    reinstall scripts/deploy/smoke-release.sh smoke-release.sh
    reinstall scripts/deploy/mica-smoke-release.sh mica-smoke-release.sh
fi

# --ignore-scripts: same reason the Dockerfile and CI use it -- the root "prepare" script
# installs dev git hooks into the submodule's git dir, which a deploy has no use for.
CI=true pnpm install --frozen-lockfile --ignore-scripts
pnpm build

# Hand back the build output. The checkout is group-writable (setgid directories, umask 002
# above), but the bundler chmods dist/ after writing it, which locks the group out of the build
# output. Capital X so only directories and already-executable files keep +x.
#
# dist/ ONLY, deliberately. This covered node_modules too once and took the main deploy down:
# pnpm hardlinks package files from its content-addressable store, so those inodes can belong
# to whoever first populated the store, and chmod through a hardlink rewrites the mode in the
# shared store, for every project using it. node_modules is disposable and regenerated.
if [ -d dist ]; then
    chmod -R g+rwX dist
fi

GIT_SHA=$(git rev-parse HEAD)
MICA_CALVER=$(date +%Y.%m.%d).1

# The demo site. The build args are the ones compose.yaml passes; the VITE_MICA_* ones are left
# out, so the Dockerfile's own empty defaults apply. Podman keeps no HEALTHCHECK in an OCI
# image, so the unit states the probe itself.
podman build \
    --build-arg GIT_BRANCH="$target" \
    --build-arg GIT_SHA="$GIT_SHA" \
    --build-arg MICA_CALVER="$MICA_CALVER" \
    --build-arg COMPRESS_BINARY=1 \
    -t "localhost/mica-$target:local" \
    -f Dockerfile .

# The unit comes from the checkout too, so a change to it lands with the deploy that carries it.
# Notify=healthy in it makes the restart wait until the new container answers its probe, and
# fail when it never does.
mkdir -p "$HOME/.config/containers/systemd"
install -m 644 "scripts/deploy/mica-$target.container" "$HOME/.config/containers/systemd/"
systemctl --user daemon-reload
systemctl --user restart "mica-$target.service"
podman image prune -f >/dev/null

# Reload the resource on the FiveM server, which reads it off disk once, at load, and never
# again. The password is in the checkout's .env, 0600 and this account's.
#
# A bare assignment and an explicit emptiness check -- never `export VAR=$(...)`, whose status
# is export's rather than the command's. That hid this exact failure for two days: every deploy
# sent an RCON packet with a blank password, and the resource was never reloaded.
env_file=/opt/fivem-$target/.env
rcon_password=$(sed -n 's/^RCON_PASSWORD=//p' "$env_file" | head -n 1)
[ -n "$rcon_password" ] || die "no RCON_PASSWORD in $env_file -- the demo was rebuilt but micaOS was NOT reloaded"

RCON_PASSWORD=$rcon_password RCON_PORT=$rcon_port python3 - <<'PYEOF'
import os, socket, sys

pw = os.environ["RCON_PASSWORD"]
port = int(os.environ["RCON_PORT"])
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
    # the bug this step exists to have stopped having.
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

echo "reloaded micaOS on 127.0.0.1:$rcon_port"
echo "deployed $target @ $GIT_SHA"
