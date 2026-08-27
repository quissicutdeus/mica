#!/usr/bin/env bash
# Runs on the game server as the gphone deploy account, pinned by that account's
# authorized_keys as a forced command:
#
#   command="/home/gphone/bin/deploy-main.sh",no-port-forwarding,no-X11-forwarding,\
#   no-agent-forwarding,no-pty ssh-ed25519 AAAA... gphone-ci-deploy-main
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

cd "/opt/fivem-main/server-data/resources/[standalone]/gPhone/"

git fetch https://github.com/quissicutdeus/gPhone.git main
git reset --hard FETCH_HEAD

CI=true pnpm install --frozen-lockfile
pnpm build

GIT_SHA=$(git rev-parse HEAD)
MICA_CALVER=$(date +%Y.%m.%d).1

# The wrapper rebuilds the container AND reloads the resource over RCON. The
# reload used to live here and could not work: it reads RCON_PASSWORD from
# /opt/fivem-main/.env, which is 0600 and owned by the human who set the stack
# up, so this account read an empty string. `export VAR=$(...)` returns
# export's status rather than the command's, so `set -e` never fired and every
# deploy sent an RCON packet with a blank password. Root can read that file;
# this account has no business being able to.
sudo MICA_PORT=8675 GIT_BRANCH=main GIT_SHA="$GIT_SHA" MICA_CALVER="$MICA_CALVER" MICA_CONTAINER_NAME=gphone-main MICA_IMAGE_TAG=gphone-mainocal \
  /usr/local/sbin/gphone-deploy-main-compose.sh

echo "deployed main @ $GIT_SHA"
