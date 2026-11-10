# Server-side deploy scripts

The half of the deploy that runs on the game server, hoth. The workflows are the
other half, and they send **no script**: each opens an SSH session with a key
that `authorized_keys` pins to a forced command, and the server decides what
runs.

Everything here runs as one account, `fivem`, which owns `/opt/fivem-main` and
`/opt/fivem-dev` and runs every container on the box rootless, as Podman Quadlet
units of its own systemd user manager. There is no root half, no sudo and no
Docker: the account that deploys is the account that runs the containers, so
there is no privilege boundary in the deploy path to guard.

| File                    | On hoth                              | Run by                |
| ----------------------- | ------------------------------------ | --------------------- |
| `deploy.sh`             | `~fivem/bin/mica-deploy.sh`          | the dev and main keys |
| `mica-dev.container`    | `~fivem/.config/containers/systemd/` | systemd, as `fivem`   |
| `mica-main.container`   | `~fivem/.config/containers/systemd/` | systemd, as `fivem`   |
| `smoke-release.sh`      | `~fivem/bin/smoke-release.sh`        | the smoke key         |
| `mica-smoke-release.sh` | `~fivem/bin/mica-smoke-release.sh`   | `smoke-release.sh`    |
| `run-checked.sh`        | not installed                        | CI, on the runner     |

## Nothing on the box is installed by hand, after the first time

`deploy.sh` resets the checkout it deploys and then reinstalls itself from it,
by rename, so a change to it reaches hoth with the next deploy and takes effect
on the one after (a shell reads a script as it runs it; overwriting it in place
would corrupt the rest of the run). The dev deploy does the same for the two
smoke scripts, and every deploy installs its target's `.container` unit. So the
copy hoth runs is the last deploy's, and there is no hand-installed file that
can drift from the repo. On 2026-08-27 exactly that drift left a deploy fix
unapplied across two failed runs, and a reinstall nobody did after MICA-234
stopped every deploy until 2026-09-29.

The consequence to keep in mind: a change to the smoke wrapper is live on the
box after the next **dev** deploy, and an integration run dispatched before that
deploy has finished runs the previous one.

## Setting up hoth

The `fivem` account is the ansible repo's: this repo's and the fivem repo's
deploys share it, and its entry in `deploy_accounts` in that repo's
`host_vars/hoth.yml` makes it, with its subordinate ids, lingering and the two
checkouts' directories. That entry also names every key the account accepts,
these three and the fivem repo's two, and the command each is pinned to;
`rootless.yml` holds the lines to it on every run, and fails on a key it does
not name or one with no forced command. The rest is once, by hand, as `fivem`
(`runuser -u fivem` from root).

The forced commands, in `~/.ssh/authorized_keys`, with the three CI keys whose
private halves are the repository secrets `DEPLOY_KEY_DEV`, `DEPLOY_KEY_MAIN`
and `DEPLOY_KEY_SMOKE` (`DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS` complete them).
Add each with its line already pinned, so it never runs anything else:

```text
command="/home/fivem/bin/mica-deploy.sh dev",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... mica-ci-deploy-dev
command="/home/fivem/bin/mica-deploy.sh main",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... mica-ci-deploy-main
command="/home/fivem/bin/smoke-release.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... mica-ci-smoke-release
```

The target is the forced command's argument, chosen by the key and not by the
session, so the dev key cannot be talked into deploying main. **The smoke key is
a third key** because each deploy key is pinned to a command that deploys:
pointed at one, sshd would run that, ignore the zip on stdin, exit 0 and print
`deployed main @ <sha>`, and Actions would report a green smoke test that tested
nothing.

The fetch is over SSH with a read-only deploy key of this repository, never
https. In `~/.ssh/config`, with the public key added under the repository's
deploy keys (read-only) and github.com's host key in `~/.ssh/known_hosts`:

```text
Host github-mica
    HostName github.com
    User git
    IdentityFile ~/.ssh/github-mica
    IdentitiesOnly yes
```

The first copies of the scripts, from either checkout; every deploy after this
reinstalls them itself:

```sh
mkdir -p ~/bin
cd /opt/fivem-dev/server-data/vendor/mica
install -m 755 scripts/deploy/deploy.sh ~/bin/mica-deploy.sh
install -m 755 scripts/deploy/smoke-release.sh scripts/deploy/mica-smoke-release.sh ~/bin/
```

Then, from the ansible repo,
`ansible-playbook rootless.yml --limit hoth -e accounts=fivem`: it stops while a
script a key is pinned to is not there, or a key it names is missing. And the
smoke test's settings, below.

## The deploy

`.github/workflows/deploy.yml` runs after a green Verify on a push to `dev` or
`main`, opens a session with that branch's key, and sends nothing. The step's
status is ssh's, which is `deploy.sh`'s. In order, it:

1. takes hoth's lock (below), waiting up to thirty minutes for a job already
   holding it rather than being dropped;
2. fetches the branch from `github-mica` into
   `/opt/fivem-<target>/server-data/vendor/mica` and resets to it, then
   reinstalls itself (and, on dev, the smoke scripts);
3. builds the FiveM resource: `pnpm install --frozen-lockfile --ignore-scripts`
   and `pnpm build`, then `chmod -R g+rwX dist`, and only `dist` (a `chmod`
   through pnpm's hardlinks rewrites the shared store's modes, and once took the
   main deploy down);
4. builds the demo site's image, `localhost/mica-<target>:local`, with the build
   args `compose.yaml` passes, installs `mica-<target>.container`, reloads the
   user manager and restarts `mica-<target>`; `Notify=healthy` makes the restart
   wait until the new container answers `/mica-serve -health`, and fail when it
   never does;
5. reloads the resource on the target's FiveM server over RCON (UDP,
   `127.0.0.1:30121` for dev, `:30120` for main), with the password from
   `/opt/fivem-<target>/.env`.

The demo containers publish `127.0.0.1:8676` (dev) and `127.0.0.1:8675` (main)
and nothing else; the box's reverse proxy serves them as dev.mica.gg and
mica.gg. The health check is stated in the unit in its JSON (exec) form: an
image Podman builds is OCI and carries no `HEALTHCHECK`, and a plain-string
`HealthCmd` runs through `/bin/sh`, which this scratch image does not have, so
it would never pass.

Two rules from the reload's history are load-bearing. It used to read the
password with `export RCON_PASSWORD=$(grep ...)` from a file the deploy account
could not read; `export` returns its own status, not the substitution's, so
`set -e` never fired and every deploy sent a blank password for two days. So:

- **Never `export VAR=$(cmd)`** when the failure matters. Assign, then check it
  is not empty.
- **A reload that did not happen is a failure, not a warning.** The deploy fails
  unless FXServer answers `Stopping resource mica`: on a timeout, a rejected
  password, or an unknown resource (the line said `micaOS` for a while after the
  rename, and every deploy reported a reload that never happened).

To deploy by hand, as `fivem`: `~/bin/mica-deploy.sh dev`.

## The release smoke test

Before `release.yml` attaches `mica-<version>.zip` to a release, it pipes the
zip over SSH to the smoke key's forced command, and the zip is released only if
it starts (MICA-220).

`smoke-release.sh` caps the size, unpacks the zip into a directory of its own
under `~fivem/smoke/`, checks it unpacked to `mica/fxmanifest.lua`, and hands
that directory to `mica-smoke-release.sh`. The wrapper copies the zip's
`resources/` out without following a link into a staging directory under
`~fivem/.cache/mica-smoke-stage/`, refuses symlinks, hardlinks and special
files, and builds and mounts everything from that copy; the run directory is
only read. It then starts a throwaway MariaDB, imports the zip's own
`mica.esx.sql`, and starts a throwaway FXServer from the main server's image
with the zip's `mica` mounted read-only beside the main checkout's `oxmysql`, in
`mica_standalone` mode, as this account (`--userns=keep-id`). The console has to
print `mica started!` within three minutes, and then, for twenty seconds more,
nothing from mica or oxmysql that reads as an error. Both containers and their
network are removed on exit, whichever way it exits; they are on a network of
their own and publish no port, so neither live stack is touched.

### Settings

`~fivem/.config/mica-smoke/smoke.env`, mode 0600, read one named key at a time
and never sourced:

```sh
# required: a licence key registered for this box, NOT one either live stack uses
LICENSE_KEY=
# the defaults, for anything they get wrong on this box
# FX_IMAGE=localhost/fivem-main-server:latest
# DB_IMAGE=docker.io/library/mariadb:noble
# OXMYSQL_DIR=/opt/fivem-main/server-data/vendor/oxmysql
# the qbx run's resources default to the directories beside OXMYSQL_DIR
# OX_LIB_DIR=
# QBX_CORE_DIR=
# OX_INVENTORY_DIR=
# QBX_VEHICLES_DIR=
# a resource ox_lib's fxmanifest.lua lists under dependencies (`require`, from ox_lib 3.42)
# is found beside OXMYSQL_DIR; DEP_<NAME>_DIR says otherwise (DEP_REQUIRE_DIR)
# the esx run's; esx_lib and legacy.sql default to beside ESX_DIR
# ESX_DIR=/opt/mica-smoke/vendor/es_extended
# ESX_LIB_DIR=
# ESX_SQL=
```

**Why a licence key of its own.** Without `sv_licenseKey` FXServer starts every
resource and then quits, which proves the zip loads and nothing past that. With
one the server stays up and mica's asynchronous start (the oxmysql connection,
the schema report, the orphan sweep's refusal on standalone) gets its window to
fail in. Two servers on one key will not both stay up, and the one that loses
could be the live one. The wrapper refuses to run without a key;
`MICA_SMOKE_KEYLESS=1` overrides that for a trial by hand and says so on every
line it prints.

**The esx run's framework.** The live servers run no ESX, so the esx run reads
it from `/opt/mica-smoke/vendor/`, root-owned and read-only, and refuses to
start, naming the path, when it is missing. The ansible repo's `hoth.yml`
installs it from one esx_core release (`esx-framework/esx_core` tag `1.15.2`,
pinned by the tag's commit and the archive's checksum) as `es_extended/` (from
`[core]/es_extended`), `esx_lib/` (from `[core]/esx_lib`, which es_extended's
manifest loads) and `legacy.sql` (from `[SQL]/legacy.sql`), and puts it back as
the release has it on every run; a newer ESX is a change there, not here. The
wrapper imports `legacy.sql`, not `es_extended.sql`: that one creates a database
of its own and lacks the `firstname`, `lastname` and `phone_number` columns of
`users` and the `licenses` table ox_inventory's esx bridge writes to.

### The integration suite (MICA-302)

The same key and wrapper also run an in-server test suite. CI sends
`pnpm pack:integration`'s zip, which holds `mica/` as released plus a test
resource, `mica-integration/`, and the wrapper switches to integration mode when
that directory is present. It generates a throwaway content keyring in a small
`mica-keys` resource (FXServer refuses a resource's reads outside resource
folders, so a key file has to sit inside one) and reads the suite's verdict from
the console: one `integration: PASS|FAIL|SKIP <id>` line per scenario and a
final `integration: done <P> passed <F> failed`. `release.yml` runs it before
the smoke test and will not release on a failure; `integration.yml` runs it
alone on any ref by `workflow_dispatch`.

**Three runs, every time (MICA-304)**, one after the other, each on a database
and a FXServer of its own, and nothing chooses between them: a run that could be
told to leave one out is one a stray edit could leave out unnoticed.

- `standalone`: `oxmysql` and micaOS on an empty database; the console has to
  say `created micaOS's schema for ESX or standalone`.
- `qbx`: `oxmysql`, `ox_lib`, `qbx_core`, `qbx_vehicles` and `ox_inventory`
  before micaOS, on a database holding `qbx_core.sql`, `vehicles.sql` and one
  `players` row; the console has to say `created micaOS's schema for qbx/qb` and
  `mica: jobs -> qbx_core`.
- `esx`: `oxmysql`, `ox_lib`, `esx_lib`, `es_extended` and `ox_inventory` before
  micaOS, on a database holding `legacy.sql` and one `users` row; the console
  has to say `created micaOS's schema for ESX or standalone` and
  `mica: jobs -> es_extended`.

**ox_lib's own dependencies (MICA-479).** The qbx and esx runs read the mounted
`ox_lib/fxmanifest.lua` and, for every resource it names under `dependencies` or
`dependency` (not the `/`-prefixed built-ins), mount that directory read-only
from beside `OXMYSQL_DIR` and `ensure` it before `ox_lib`. ox_lib 3.42 and later
name `require`, which is
[overextended/cfxlua-require](https://github.com/overextended/cfxlua-require),
so the box needs it at `/opt/fivem-main/server-data/vendor/require` (or
`DEP_REQUIRE_DIR` in `smoke.env`). A dependency that is not there refuses the
whole invocation before any container starts, naming it and the path; a stack
whose console prints `Could not find dependency` or `Couldn't start resource`
fails its run at once instead of timing out scenario by scenario.

micaOS must create its own schema on first start in every run (MICA-306); the
release smoke test is the only run that imports micaOS's SQL. The seeded
characters are in the wrapper (`seed_qbx`, `seed_esx`) and in
`integration/lib/qbxSeed.ts` and `esxSeed.ts`, and
`server/__tests__/smokeWrapperQbx.test.ts` and `smokeWrapperEsx.test.ts` hold
each pair equal. `pack:integration` writes
`mica-integration/expected-scenarios.txt`, one `<mode> pass|skip <id>` line per
scenario per run, and each run's PASS lines must be exactly its scenarios and
its SKIP lines exactly the others', so a dropped scenario is a difference, not a
smaller count. A failing run ends the invocation, and its messages are tagged
`[standalone mode]`, `[qbx mode]` or `[esx mode]`. The workflows also require,
through `run-checked.sh`'s `RUN_CHECKED_REQUIRE`, a pass line from every mode in
the output, so a wrapper edited to leave one out is red even though it exits 0.

### Trying it by hand

From a checkout, with a zip `pnpm pack:resource` produced:

```sh
mkdir -p /tmp/smoke/root && run=$(mktemp -d /tmp/smoke/root/XXXXXXXX)
mkdir "$run/resources" && unzip -q dist/release/mica-*.zip -d "$run/resources"
printf 'OXMYSQL_DIR=/opt/fivem/server-data/vendor/oxmysql\n' > /tmp/smoke/settings
MICA_SMOKE_KEYLESS=1 MICA_SMOKE_ROOT=/tmp/smoke/root MICA_SMOKE_ENV=/tmp/smoke/settings \
  scripts/deploy/mica-smoke-release.sh "$run"
```

`MICA_HOTH_LOCK`, `MICA_HOTH_LOCK_TIMEOUT`, `MICA_SMOKE_STAGE`,
`MICA_SMOKE_SETTLE`, `MICA_SMOKE_INTEGRATION_TIMEOUT` and
`MICA_SMOKE_FAKE_CLOCK` exist for the tests. A CI session cannot set any of
them: sshd passes a forced command no environment.

## One job at a time on hoth (MICA-315)

On 2026-10-06 an integration run dispatched while a dev deploy was rebuilding
the stack's image died with exit 1 and no line saying why. So the deploys and
the smoke and integration runs take **one lock**,
`$XDG_RUNTIME_DIR/mica-hoth.lock` (in `/run/user/<fivem's uid>/`), and run one
at a time: they share the account's images and container store, and the smoke
runs share a licence key. A job that finds it held prints who holds it (the
holder writes a line naming itself) and waits, the smoke wrapper up to 25
minutes and a deploy up to 30, then gives up without starting anything. The lock
is created `0644`, and the smoke wrapper refuses one that is a symlink, owned by
another user, or writable by group or others.

Every run of the smoke wrapper also ends with one status line, so a failure says
what failed:

| What ended the run                            | What is printed                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| a command failed under `set -e`               | `mica-wrapper: <name> FAILED at line <n>: <the command, as written> (exit status <s>)` |
| a deliberate refusal                          | `REFUSED: <reason>`, then the status line                                              |
| bash's own error, such as an unset `${VAR:?}` | bash's message, then a status line saying no step named a reason                       |
| a signal, or an `exit 0` before the end       | `... FAILED: the run ended before it finished, so it is not a pass`                    |
| success                                       | `mica-wrapper: <name> finished ok`                                                     |

The command is shown as written, with its variables unexpanded, so nothing a
variable holds (a licence key, a password) can reach the log. `finished ok` is
printed only by a run that reached its final statement: bash runs the exit trap
with the status of the last command, not the signal's, so a killed run would
otherwise report itself a pass.
