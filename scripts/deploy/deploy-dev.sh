#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 quissicutdeus
#
# SPDX-License-Identifier: AGPL-3.0-or-later

# Runs on the game server as the gphone deploy account, pinned by that account's
# authorized_keys as a forced command:
#
#   command="/home/gphone/bin/deploy-dev.sh",no-port-forwarding,no-X11-forwarding,\
#   no-agent-forwarding,no-pty ssh-ed25519 AAAA... gphone-ci-deploy-dev
#
# .github/workflows/deploy.yml opens an SSH session with that key and sends
# nothing; sshd runs this instead. See scripts/deploy/README.md -- these are NOT
# installed by CI and do not update themselves.
set -euo pipefail
umask 002

# One deploy at a time, whatever started it.
#
# Everything below operates on a single working tree: it git-resets it, reinstalls its
# node_modules and rebuilds its dist. Two of these at once is two `git reset --hard` in one
# checkout and two `pnpm install` writing one `node_modules` -- and it has happened, twice
# concurrently for ~2.5 minutes on 2026-08-27, with both runs reporting success.
#
# `deploy.yml` fixes the cause it knew about (a `pull_request`-triggered Verify firing a
# second deploy) and adds a `concurrency` group. Neither helps a run started by hand, or by
# anything that is not that workflow, which is why the lock lives here as well: this is the
# only place that sees every caller.
#
# `-w 1800`, not `-n`: a deploy that arrives mid-deploy should land after it, not be
# dropped. Thirty minutes is far past a normal run and short of hanging forever. `9<` on the
# script itself needs no separate lockfile to create, permission, or clean up.
exec 9<"$0"
flock -w 1800 9 || {
    echo "another deploy has held the lock for 30 minutes; refusing to pile on" >&2
    exit 1
}

cd "/opt/fivem-dev/server-data/resources/[standalone]/mica/"

git fetch https://github.com/quissicutdeus/mica.git dev
git reset --hard FETCH_HEAD

# Re-install this script from the checkout it just reset. README.md here says a
# change to these is inert until someone copies it to the box, and on 2026-08-27
# that drift is exactly what left a deploy fix unapplied across two failed runs.
# Only the unprivileged half self-updates: the root-owned compose scripts in
# /usr/local/sbin stay hand-installed on purpose, because a deploy account that
# could rewrite what it invokes as root would not be an unprivileged account.
#
# rename(2) rather than a copy in place: bash reads a script incrementally, so
# overwriting this file mid-run would corrupt whatever it has not read yet. The
# new version therefore takes effect on the NEXT deploy, not this one.
install -m 755 scripts/deploy/deploy-dev.sh "$HOME/bin/.deploy-dev.sh.new"
mv -f "$HOME/bin/.deploy-dev.sh.new" "$HOME/bin/deploy-dev.sh"

# --ignore-scripts: same reason the Dockerfile and CI use it -- the root
# "prepare" script installs dev git hooks into the submodule's git dir, which
# this account cannot write to and which a deploy has no use for anyway.
CI=true pnpm install --frozen-lockfile --ignore-scripts
pnpm build

# Hand back the build output. The checkout carries a default ACL (see
# scripts/fix-perms.sh in the superproject) so new files land 664/2775, but an
# ACL only decides the mode at CREATION and the bundler chmods dist/ after
# writing it -- which locks the interactive account out of the build output
# until someone re-runs fix-perms as root. No root needed here: this account
# built dist/ and owns it. Capital X so only directories and already-executable
# files keep +x.
#
# dist/ ONLY, deliberately. This loop covered node_modules too and took the main
# deploy down: pnpm hardlinks package files from its content-addressable store,
# so those inodes belong to whoever first populated the store and chmod returns
# EPERM for this account. Even where it succeeded it would be wrong -- chmod
# through a hardlink rewrites the mode in the shared store, for every project
# using it. node_modules is disposable and regenerated; leave it alone.
if [ -d dist ]; then
    chmod -R g+rwX dist
fi

GIT_SHA=$(git rev-parse HEAD)
MICA_CALVER=$(date +%Y.%m.%d).1

# The wrapper rebuilds the container AND reloads the resource over RCON. The
# reload used to live here and could not work: it reads RCON_PASSWORD from
# /opt/fivem-dev/.env, which is 0600 and owned by the human who set the stack
# up, so this account read an empty string. `export VAR=$(...)` returns
# export's status rather than the command's, so `set -e` never fired and every
# deploy sent an RCON packet with a blank password. Root can read that file;
# this account has no business being able to.
sudo MICA_PORT=8676 GIT_BRANCH=dev GIT_SHA="$GIT_SHA" MICA_CALVER="$MICA_CALVER" MICA_CONTAINER_NAME=mica-dev MICA_IMAGE_TAG=mica-dev:local \
    /usr/local/sbin/mica-deploy-dev-compose.sh

echo "deployed dev @ $GIT_SHA"
