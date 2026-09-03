# Server-side deploy scripts

The half of the deploy that runs on the game server.
`.github/workflows/deploy.yml` is the other half, and it sends **no script** —
it opens an SSH session with a key that `authorized_keys` pins to a forced
command, and the server decides what runs.

| File                         | Installed to                        | Runs as                      |
| ---------------------------- | ----------------------------------- | ---------------------------- |
| `deploy-dev.sh`              | `/home/gphone/bin/deploy-dev.sh`    | `gphone`, via forced command |
| `deploy-main.sh`             | `/home/gphone/bin/deploy-main.sh`   | `gphone`, via forced command |
| `gos-deploy-dev-compose.sh`  | `/usr/local/sbin/`                  | `root`, via `sudoers`        |
| `gos-deploy-main-compose.sh` | `/usr/local/sbin/`                  | `root`, via `sudoers`        |
| `smoke-release.sh`           | `/home/gphone/bin/smoke-release.sh` | `gphone`, via forced command |
| `gos-smoke-release.sh`       | `/usr/local/sbin/`                  | `root`, via `sudoers`        |

## The unprivileged half self-installs; the privileged half does not

`deploy-dev.sh` and `deploy-main.sh` re-install themselves from the checkout
they just reset, so a change to either reaches the box on the next deploy and
takes effect on the one after that. They copy to a temp name and `mv` it into
place rather than writing over themselves: bash reads a script incrementally,
and overwriting it mid-run corrupts whatever it has not read yet.

The root-owned compose scripts still need copying by hand:

```sh
# privileged half -- root-owned so the deploy account cannot edit what it invokes
sudo install -m 700 -o root -g root \
  scripts/deploy/gos-deploy-dev-compose.sh /usr/local/sbin/
```

That asymmetry is the point: a deploy account that could rewrite the script it
invokes as root would not be an unprivileged account. The unprivileged pair has
no such problem — it already runs as `gphone` and already resets the checkout it
copies from, so self-installing grants it nothing it did not have.

Bootstrapping is still manual, once, before the first deploy of these:

```sh
install -m 755 scripts/deploy/deploy-dev.sh ~gphone/bin/deploy-dev.sh
```

Check which version is actually live with `sha256sum` on both sides.

**The current change worth copying up is the `flock`** at the top of
`deploy-dev.sh` and `deploy-main.sh`. Until it is on the box, nothing
server-side stops two deploys running at once — and on 2026-08-27 two ran
concurrently for about two and a half minutes against the same checkout, both
reporting success. `.github/workflows/deploy.yml` now fixes the cause it knew
about and adds a `concurrency` group, but a run started by hand still bypasses
both; the lock is the only guard that sees every caller.

## The release smoke test

The other thing this box does for CI (MICA-220): before `release.yml` attaches
`gos-<version>.zip` to a release, it pipes the zip over SSH to a third forced
command here, and the zip is released only if it starts.

`smoke-release.sh` runs as `gphone` with the zip on stdin. It caps the size,
unpacks it into a directory of its own under `~gphone/smoke/`, checks it
unpacked to `gos/fxmanifest.lua`, and hands that directory to the root wrapper.
`gos-smoke-release.sh` then starts a throwaway MariaDB, imports the zip's own
`gos.esx.sql` into it, and starts a throwaway FXServer from the stack's own
image with the zip's `gos` mounted read-only beside the main checkout's
`oxmysql`, in `gos_standalone` mode. The console has to print `gos started!`
within three minutes, and then, for twenty seconds more, nothing from gos or
oxmysql that reads as an error. Both containers and their network are removed on
exit, whichever way it exits, and nothing here touches either live stack: the
containers are on a network of their own and publish no port.

**Why a third key, not one of the two deploy keys.** Each deploy key is pinned
to a command that deploys. Point the workflow at one and sshd runs that, ignores
stdin, exits 0 and prints `deployed main @ <sha>` — and Actions reports a green
smoke test that tested nothing.

**Why a licence key of its own.** Without `sv_licenseKey` FXServer starts every
resource and then quits, which proves the zip loads and nothing past that. With
one the server stays up and gos's asynchronous start — the oxmysql connection,
the schema report, the orphan sweep's refusal on standalone — gets its window to
fail in. It has to be a key registered for this box and **not the one either
live stack uses**: two servers on one key will not both stay up, and the one
that loses could be the live one. The wrapper refuses to run without a key;
`GOS_SMOKE_KEYLESS=1` overrides that for a trial by hand and says so on every
line it prints.

### Installing it

Once, and none of it updates itself — `smoke-release.sh` has no checkout to
re-install from, unlike `deploy-<target>.sh`:

```sh
# the unprivileged half, as gos
install -m 755 scripts/deploy/smoke-release.sh ~gphone/bin/smoke-release.sh

# the privileged half, root-owned so the deploy account cannot edit what it invokes
sudo install -m 700 -o root -g root \
  scripts/deploy/gos-smoke-release.sh /usr/local/sbin/

# let gos invoke it by exact path, with a run directory as its one argument
echo 'gphone ALL=(root) NOPASSWD: /usr/local/sbin/gos-smoke-release.sh /home/gphone/smoke/*' |
  sudo tee /etc/sudoers.d/gos-smoke >/dev/null && sudo chmod 440 /etc/sudoers.d/gos-smoke

# the licence key, and anything the defaults get wrong for this box
sudo install -m 600 -o root -g root /dev/null /etc/gos-smoke.env
sudo tee /etc/gos-smoke.env >/dev/null <<'ENV'
LICENSE_KEY=<a key registered for this box, distinct from both stacks'>
# FX_IMAGE=fivem-server:latest
# DB_IMAGE=mariadb:noble
# OXMYSQL_DIR=/opt/fivem-main/server-data/vendor/oxmysql
ENV
```

The wrapper reads that file one named key at a time rather than sourcing it.
`FX_IMAGE` is the stack's own FXServer image (`docker images | grep server`; the
compose project `fivem` builds `fivem-server`), so the smoke test runs the
artifact the live servers run. Both images have to exist already; nothing here
pulls or builds one.

Then a key for the workflow, as `gphone`:

```sh
ssh-keygen -t ed25519 -C gphone-ci-smoke-release -f ~/.ssh/gphone-ci-smoke-release -N ''
{ printf 'command="%s",no-port-forwarding,no-X11-forwarding,' "$HOME/bin/smoke-release.sh"
  printf 'no-agent-forwarding,no-pty '
  cat ~/.ssh/gphone-ci-smoke-release.pub
} >> ~/.ssh/authorized_keys
cat ~/.ssh/gphone-ci-smoke-release    # -> the DEPLOY_KEY_SMOKE secret, then shred the private half here
```

`DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS` are the ones the deploy already uses. A
release with `DEPLOY_KEY_SMOKE` unset fails at the smoke step, by design: the
zip is not attached untested, and the tag it already pushed gets its release
when the run is re-run with the secret in place.

### Trying it by hand

From the repo, with a zip `pnpm pack:resource` produced, as any user who can run
Docker — the trust root and the settings file can be pointed elsewhere only when
the wrapper is not root:

```sh
mkdir -p /tmp/smoke/root && run=$(mktemp -d /tmp/smoke/root/XXXXXXXX)
mkdir "$run/resources" && unzip -q dist/release/gos-*.zip -d "$run/resources"
printf 'OXMYSQL_DIR=/opt/fivem/server-data/vendor/oxmysql\n' > /tmp/smoke/settings
GOS_SMOKE_KEYLESS=1 GOS_SMOKE_ROOT=/tmp/smoke/root GOS_SMOKE_ENV=/tmp/smoke/settings \
  scripts/deploy/gos-smoke-release.sh "$run"
```

On the box itself, the whole path as CI drives it:

```sh
ssh -i ~/.ssh/gphone-ci-smoke-release gphone@localhost < dist/release/gos-*.zip
```

## Never invoke two at once

A second deploy waits up to thirty minutes for the first, then gives up rather
than piling on — `-w 1800` rather than `-n`, because a deploy arriving
mid-deploy should land after it, not be silently dropped. Concurrency is not
free of consequence here: each script git-resets one working tree, reinstalls
its `node_modules` and rebuilds its `dist`.

## Never invoke the wrappers directly

Run `~gphone/bin/deploy-<target>.sh`. The wrapper is not a standalone entry
point: `compose.yaml` takes the container name, port, image tag and version
labels from the environment, and it is the deploy script that sets them.

Run bare, those are simply unset, and compose falls back to the defaults in
`compose.yaml` — whose `container_name` is the same string for both targets. The
result is that one target's live container gets renamed to that default and the
other then collides with it, leaving the running container removed and its
replacement stuck in `Created`. The wrappers now refuse to start without those
variables, which is the only reason this is a paragraph and not an outage.

To exercise the path by hand, use the deploy script:

```sh
sudo -u gphone /home/gphone/bin/deploy-dev.sh
```

## Why the split

`gos` is not in the `docker` group — on a shared host that is root-equivalent,
and this path runs `pnpm install` over third-party dependencies. So the
container rebuild happens in a root-owned wrapper that `sudoers` lets this
account invoke by exact path and nothing else.

The wrapper verifies `compose.yaml` against a pinned SHA256 before acting on it.
The deploy account can write that file (git needs to), so the file is not
trustworthy — only the hash is. A legitimate change to it means updating
`EXPECTED_SHA` by hand, which is the review step that change deserves.

The RCON reload lives in the wrapper for the same reason: `RCON_PASSWORD` is in
`/opt/fivem-<target>/.env`, mode 0600 and owned by whoever set the stack up.
Root can read it; the deploy account cannot, and should not.

## The bug this layout fixed

The reload used to run in `deploy-<target>.sh`, as `gphone`, and had never once
worked:

```sh
export RCON_PASSWORD=$(grep '^RCON_PASSWORD=' /opt/fivem-dev/.env | cut -d= -f2-)
```

`grep` failed on a file this account cannot read, and `export VAR=$(...)`
returns _export's_ exit status, not the substitution's — so `set -e` never
fired. Every deploy sent an RCON packet with an empty password. The container
rebuilt fine, so the deploy looked green; the running FXServer kept serving the
resource it had loaded at boot. The only symptom was
`rcon: no response (timeout)`, which reads like a network hiccup.

Two rules came out of it, and both are load-bearing:

- **Never `export VAR=$(cmd)`** when the failure matters. Assign, then check.
  `VAR=$(cmd)` propagates the status; `export VAR=$(cmd)` swallows it.
- **A reload that did not happen is a failure, not a warning.** The wrapper
  exits non-zero on a timeout or a rejected password rather than printing and
  moving on.
