# Server-side deploy scripts

The half of the deploy that runs on the game server.
`.github/workflows/deploy.yml` is the other half, and it sends **no script** —
it opens an SSH session with a key that `authorized_keys` pins to a forced
command, and the server decides what runs.

| File                            | Installed to                      | Runs as                      |
| ------------------------------- | --------------------------------- | ---------------------------- |
| `deploy-dev.sh`                 | `/home/gphone/bin/deploy-dev.sh`  | `gphone`, via forced command |
| `deploy-main.sh`                | `/home/gphone/bin/deploy-main.sh` | `gphone`, via forced command |
| `gphone-deploy-dev-compose.sh`  | `/usr/local/sbin/`                | `root`, via `sudoers`        |
| `gphone-deploy-main-compose.sh` | `/usr/local/sbin/`                | `root`, via `sudoers`        |

## These are not installed by CI

Nothing deploys them. A change here is inert until someone copies it to the box:

```sh
# unprivileged half
install -m 755 scripts/deploy/deploy-dev.sh ~gphone/bin/deploy-dev.sh

# privileged half -- root-owned so the deploy account cannot edit what it invokes
sudo install -m 700 -o root -g root \
  scripts/deploy/gphone-deploy-dev-compose.sh /usr/local/sbin/
```

That is deliberate for the root-owned pair: a deploy account that could rewrite
the script it runs as root would not be an unprivileged account. It is merely
unavoidable for the other two, which live outside the checkout they reset.

Check which version is actually live with `sha256sum` on both sides.

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

`gphone` is not in the `docker` group — on a shared host that is
root-equivalent, and this path runs `pnpm install` over third-party
dependencies. So the container rebuild happens in a root-owned wrapper that
`sudoers` lets this account invoke by exact path and nothing else.

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
