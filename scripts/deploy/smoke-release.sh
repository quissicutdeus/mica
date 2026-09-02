#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 quissicutdeus
#
# SPDX-License-Identifier: AGPL-3.0-or-later

# Runs on the game server as the gphone deploy account, pinned by that account's
# authorized_keys as a forced command (MICA-220):
#
#   command="/home/gphone/bin/smoke-release.sh",no-port-forwarding,no-X11-forwarding,\
#   no-agent-forwarding,no-pty ssh-ed25519 AAAA... gphone-ci-smoke-release
#
# .github/workflows/release.yml opens an SSH session with that key and pipes the
# release zip to it; sshd runs this with the zip on stdin. The zip is the entire
# client-supplied surface: it is size-capped, unpacked into a directory of its
# own, and handed to the root-owned wrapper, which starts a throwaway FXServer
# with it. See scripts/deploy/README.md -- this is NOT installed by CI and, unlike
# deploy-<target>.sh, has no checkout to re-install itself from.
set -euo pipefail
umask 077

SMOKE_ROOT="$HOME/smoke"
# Sixty-four mebibytes. The zip is under ten; a cap that is not reached is the
# point, and a stdin that is not a zip at all stops here rather than on disk.
MAX_BYTES=$((64 * 1024 * 1024))

die() {
    echo "smoke-release: $*" >&2
    exit 1
}

mkdir -p "$SMOKE_ROOT"
run=$(mktemp -d "$SMOKE_ROOT/XXXXXXXX")
cleanup() { rm -rf "$run"; }
trap cleanup EXIT

# One byte past the cap, so an oversize stream is detected rather than silently
# truncated into something unzip then rejects for the wrong reason.
head -c "$((MAX_BYTES + 1))" >"$run/gphone.zip"
size=$(stat -c %s "$run/gphone.zip")
[ "$size" -gt 0 ] || die "nothing arrived on stdin; the zip is expected there"
[ "$size" -le "$MAX_BYTES" ] || die "stdin exceeds ${MAX_BYTES} bytes; refusing"

# unzip drops absolute paths and `..` components on its own. The zip this
# repo writes carries neither, nor symlinks, and the wrapper checks that again
# before mounting anything.
mkdir "$run/resources"
unzip -q "$run/gphone.zip" -d "$run/resources" || die "stdin is not a zip unzip can read"
[ -f "$run/resources/gphone/fxmanifest.lua" ] ||
    die "the zip does not unpack to gphone/fxmanifest.lua; that is the layout the release ships"

# The privileged half: gphone is not in the docker group (see README.md here),
# so the containers are started by a root-owned wrapper that sudoers lets this
# account invoke by exact path, with a run directory under $SMOKE_ROOT as its
# one argument.
exec sudo /usr/local/sbin/gphone-smoke-release.sh "$run"
