#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 quissicutdeus
#
# SPDX-License-Identifier: AGPL-3.0-or-later

# Root-owned deploy wrapper. gos can only invoke this exact script via sudoers;
# it cannot edit it. Before trusting compose.yaml to define what runs as root, verify
# its content matches this pinned hash -- gos has write access to that file (git
# needs it) so the file itself is not trustworthy, only this hash is.
#
# The RCON reload lives HERE, not in ~gphone/bin/deploy-main.sh, because the password
# is in /opt/fivem-main/.env -- 0600, owned by mbiddle. gos cannot read it; root
# can. The old code read it as gos and got an empty string, and because
# `export VAR=$(...)` returns export's status rather than the command's, it sailed
# straight past `set -e` and sent an RCON packet with a blank password on every
# deploy. The resource was never reloaded. The "no response (timeout)" line it
# printed was the only symptom, and it looked like a network hiccup.
set -euo pipefail

COMPOSE_FILE="/opt/fivem-main/server-data/vendor/gos/compose.yaml"
# Re-pinned for MICA-269: the gPhone -> gOS rename changed every
# MICA_* variable and the image and container names in compose.yaml.
# Reviewed before re-pinning, which is the whole point of this gate:
# the diff is the rename and nothing structural.
EXPECTED_SHA="7e803fb94fdf95ada841d88f07b1e4573af4329aa77b400c7c4169dcea04f661"
ENV_FILE="/opt/fivem-main/.env"
FIVEM_PORT=30120

# compose.yaml reads these from the environment. deploy-<target>.sh supplies
# them and sudoers env_keeps them across the sudo boundary -- but nothing made
# them REQUIRED, and unset they do not error: compose quietly falls back to the
# defaults baked into compose.yaml, whose container_name is the same string for
# both targets. So running this script bare renames one target's container to
# that default and then collides with it from the other, leaving the live
# container removed and the replacement stuck in Created. Ask how I know.
: "${GOS_PORT:?not set -- invoke ~gphone/bin/deploy-<target>.sh, not this directly}"
: "${GIT_BRANCH:?not set -- invoke ~gphone/bin/deploy-<target>.sh, not this directly}"
: "${GIT_SHA:?not set -- invoke ~gphone/bin/deploy-<target>.sh, not this directly}"
: "${GOS_CALVER:?not set -- invoke ~gphone/bin/deploy-<target>.sh, not this directly}"
: "${GOS_CONTAINER_NAME:?not set -- invoke ~gphone/bin/deploy-<target>.sh, not this directly}"
: "${GOS_IMAGE_TAG:?not set -- invoke ~gphone/bin/deploy-<target>.sh, not this directly}"

ACTUAL_SHA=$(sha256sum "$COMPOSE_FILE" | cut -d' ' -f1)
if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
    echo "REFUSED: $COMPOSE_FILE does not match the pinned hash." >&2
    echo "expected: $EXPECTED_SHA" >&2
    echo "actual:   $ACTUAL_SHA" >&2
    echo "If this is a legitimate change, update EXPECTED_SHA in this script by hand." >&2
    exit 1
fi

docker compose -p gos-main -f "$COMPOSE_FILE" up -d --build

# Bare assignment guarded by an explicit emptiness check -- never
# `export VAR=$(...)`, which is what hid this failure for two days.
RCON_PASSWORD=$(grep -m1 '^RCON_PASSWORD=' "$ENV_FILE" | cut -d= -f2- || true)
if [[ -z "$RCON_PASSWORD" ]]; then
    echo "REFUSED: no RCON_PASSWORD in $ENV_FILE -- gOS was rebuilt but NOT reloaded" >&2
    exit 1
fi

export RCON_PASSWORD FIVEM_PORT
python3 - <<'PYEOF'
import os, socket, sys

pw = os.environ["RCON_PASSWORD"]
port = int(os.environ["FIVEM_PORT"])
msg = b"\xff\xff\xff\xffrcon " + pw.encode() + b" restart gOS"

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(5)
s.sendto(msg, ("127.0.0.1", port))
try:
    reply = s.recvfrom(65535)[0].decode(errors="replace")
except socket.timeout:
    # Fail, do not warn. A reload that silently did not happen is precisely
    # the bug this script exists to have stopped having.
    sys.exit(f"rcon: no response from 127.0.0.1:{port} within 5s -- gOS NOT reloaded")
print(reply.strip())
if "Invalid password" in reply:
    sys.exit("rcon: server rejected the password -- gOS NOT reloaded")
PYEOF

echo "reloaded gOS on 127.0.0.1:$FIVEM_PORT"
