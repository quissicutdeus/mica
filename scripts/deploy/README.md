# Server-side deploy scripts

The half of the deploy that runs on the game server.
`.github/workflows/deploy.yml` is the other half, and it sends **no script** —
it opens an SSH session with a key that `authorized_keys` pins to a forced
command, and the server decides what runs.

| File                          | Installed to                        | Runs as                      |
| ----------------------------- | ----------------------------------- | ---------------------------- |
| `deploy-dev.sh`               | `/home/gphone/bin/deploy-dev.sh`    | `gphone`, via forced command |
| `deploy-main.sh`              | `/home/gphone/bin/deploy-main.sh`   | `gphone`, via forced command |
| `mica-deploy-dev-compose.sh`  | `/usr/local/sbin/`                  | `root`, via `sudoers`        |
| `mica-deploy-main-compose.sh` | `/usr/local/sbin/`                  | `root`, via `sudoers`        |
| `smoke-release.sh`            | `/home/gphone/bin/smoke-release.sh` | `gphone`, via forced command |
| `mica-smoke-release.sh`       | `/usr/local/sbin/`                  | `root`, via `sudoers`        |
| `gphone-deploy.sudoers`       | `/etc/sudoers.d/gphone-deploy`      | read by `sudo`, mode 440     |
| `check-wrapper-identity.sh`   | not installed                       | CI, on the runner            |
| `run-checked.sh`              | not installed                       | CI, on the runner            |

## The unprivileged half self-installs; the privileged half does not

`deploy-dev.sh` and `deploy-main.sh` re-install themselves from the checkout
they just reset, so a change to either reaches the box on the next deploy and
takes effect on the one after that.

**That only holds if the deploy gets far enough to reach the self-install.** The
`cd` into the resource directory is line 40; the self-install is line 55. So a
change to the path in that `cd` -- a resource rename -- cannot arrive this way:
the installed copy dies on line 40 looking for the old directory, never reaches
line 55, and stays frozen at the old path no matter how many correct pushes
follow. That is not hypothetical; it is what kept every deploy failing in nine
seconds between 2026-09-03 and 2026-09-04, on both stacks, while the repo said
something else entirely. **A rename that touches these paths has to be
hand-installed on the box, both halves**, and the `sha256sum` check below is how
you confirm it took. They copy to a temp name and `mv` it into place rather than
writing over themselves: bash reads a script incrementally, and overwriting it
mid-run corrupts whatever it has not read yet.

The root-owned compose scripts still need copying by hand:

```sh
# privileged half -- root-owned so the deploy account cannot edit what it invokes
sudo install -m 700 -o root -g root \
  scripts/deploy/mica-deploy-dev-compose.sh /usr/local/sbin/
```

That asymmetry is the point: a deploy account that could rewrite the script it
invokes as root would not be an unprivileged account. The unprivileged pair has
no such problem — it already runs as `gphone` and already resets the checkout it
copies from, so self-installing grants it nothing it did not have.

### Is hoth running the copy in the repo? The identity line

The price of that asymmetry is that **when a root wrapper changes in the repo
and nobody reinstalls it, hoth silently runs the old one.** On 2026-10-06
(MICA-306) the smoke wrapper changed and the box kept the old one; the only
reason anyone knew was that the new scenario happened to fail loudly. So the
wrappers now report on themselves, and CI refuses to pass without the report.

Each of the three root wrappers prints, as its first output line, before any
guard that could refuse the run:

```text
mica-wrapper: mica-smoke-release.sh sha256 <64 hex digits of the file's own bytes>
```

`check-wrapper-identity.sh <wrapper> <ssh output>` hashes the **checked-out**
copy of that wrapper and holds the SSH session's output to it. Every CI step
that reaches a wrapper calls it through `run-checked.sh <wrapper> ssh ...`,
which is the SSH session plus the check, with the session's own exit status kept
(a bare `ssh | tee` would report `tee`'s). The step fails when:

- no identity line for that wrapper is in the output, which is a wrapper too old
  to print one, and so the very thing this exists to catch;
- any identity line carries a hash other than the checkout's, or something that
  is not a hash; or
- the checked-out wrapper cannot be read or hashed.

It never passes silently, and nothing in a workflow turns it off. The message
is:

```text
hoth's `mica-smoke-release.sh` is stale or missing: reinstall it.
  expected sha256 (scripts/deploy/mica-smoke-release.sh in this checkout): <hash>
  hoth reported:                                          <hash(es), or "no ... line">
Reinstall it on hoth, from a checkout of this commit:
  sudo install -m 700 -o root -g root scripts/deploy/mica-smoke-release.sh /usr/local/sbin/
```

| Job                                      | Wrapper checked               | Expected hash comes from     |
| ---------------------------------------- | ----------------------------- | ---------------------------- |
| `deploy.yml` `deploy-dev`                | `mica-deploy-dev-compose.sh`  | the commit being deployed    |
| `deploy.yml` `deploy-main`               | `mica-deploy-main-compose.sh` | the commit being deployed    |
| `release.yml` integration step and smoke | `mica-smoke-release.sh`       | the commit it runs from      |
| `integration.yml`                        | `mica-smoke-release.sh`       | the ref it was dispatched on |

`release.yml` compares against `github.sha`, not the tag it releases: for a push
to `main` they are one commit, and for `gh workflow run release.yml -f tag=...`
the older tag's own wrapper predates whatever hoth now runs, and the check
itself.

**On a deploy it fails after the deploy ran, and says so.** The wrapper is
reached at the end of the deploy, behind a forced command that takes no
arguments, so there is no way to ask hoth for its hash first without a new key
and a new forced command. The deploy of a stale wrapper therefore has already
happened by the time it is found; the step goes red anyway, which reddens the
run and the commit and mails whoever pushed, and the next deploy fails the same
way until the wrapper is reinstalled. Treat the red as the instruction. For the
release and integration runs the wrapper prints its line before it does
anything, so the verdict arrives with the suite's own, and a stale wrapper's run
is red even if its suite passed.

**What to do when it fails.** On hoth, as a user with `sudo`, from a checkout of
the commit CI names:

```sh
sudo install -m 700 -o root -g root scripts/deploy/<wrapper> /usr/local/sbin/
sha256sum /usr/local/sbin/<wrapper> scripts/deploy/<wrapper>   # the two must agree
```

and re-run the failed job. Changing a compose wrapper's pinned `EXPECTED_SHA`
(below) is the same reinstall. If a job reports `no ... line` and the wrapper
was just reinstalled, the run died before it reached the wrapper: read the
step's own error above the message first.

This grants `gphone` and CI nothing: the check only reads what the wrapper
prints. The wrappers stay root-owned, the sudoers rules are unchanged, and the
only way to a current wrapper is still a person running `sudo install`. It is a
staleness check, not tamper-proofing: a wrapper edited on the box to print the
right line would pass it.

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

## The sudoers rules, in full

Neither wrapper can be invoked without these, and they are not derivable from
anything else on the box, so they are committed as `gphone-deploy.sudoers` and
shown here word for word. `server/__tests__/deployWrapper.test.ts` fails when
this block and the file differ, when the file carries `SETENV`, when its list of
variables is not the list `deploy-<target>.sh` sends and the wrapper requires,
and when `visudo -cf` does not parse it.

```sh
# /etc/sudoers.d/gphone-deploy on hoth, mode 440, root:root. Not installed by CI: a person
# installs it, after `visudo -cf`, as scripts/deploy/README.md says. server/__tests__/
# deployWrapper.test.ts holds this file to what deploy-<target>.sh sends and to "no SETENV".
#
# gphone may run the two root deploy wrappers by exact path, and set exactly the six variables
# deploy-<target>.sh sets on the sudo command line, and nothing else. There is no SETENV: with
# it, `sudo BASH_ENV=... <wrapper>` is allowed, bash sources BASH_ENV as root before the first
# line of the script, and that is root code execution for anyone holding a shell as gphone
# (MICA-316). Without it, a variable set on the command line is held to the same rules as one in
# the caller's environment (sudo(8)): env_reset drops it unless env_keep names it, so the six
# names below pass and every other name is refused with "sorry, you are not allowed to set the
# following environment variables". NOSETENV is spelled out so that a later
# `Defaults:gphone setenv` cannot quietly bring the hole back for these two commands.
#
# What the wrapper does with the six values is its own job: it holds each to the one value or
# shape it accepts (mica-deploy-<target>-compose.sh, require_value).
#
# The release smoke wrapper has its own file, /etc/sudoers.d/mica-smoke, and takes no variable.
Cmnd_Alias MICA_DEPLOY_COMPOSE = /usr/local/sbin/mica-deploy-dev-compose.sh, \
                                 /usr/local/sbin/mica-deploy-main-compose.sh
Defaults!MICA_DEPLOY_COMPOSE env_keep += "MICA_PORT GIT_BRANCH GIT_SHA MICA_CALVER MICA_CONTAINER_NAME MICA_IMAGE_TAG"
gphone ALL=(root) NOPASSWD:NOSETENV: MICA_DEPLOY_COMPOSE
```

### No `SETENV`, six named variables (MICA-316)

Until 2026-10-06 both rules read `NOPASSWD:SETENV:`. `SETENV` exists so that
`deploy-<target>.sh` can write
`sudo MICA_PORT=8676 GIT_BRANCH=dev ... mica-deploy-dev-compose.sh`, but it does
far more than that: sudo(8) says that with it, variables set on the command line
"are not subject to the restrictions imposed by `env_check`, `env_delete`, or
`env_keep`". So
`sudo BASH_ENV=/home/gphone/x /usr/local/sbin/mica-deploy-dev-compose.sh` was
allowed, bash sources `$BASH_ENV` before a non-interactive script's first line,
and that is code execution as root for anyone holding a shell as `gphone`. The
CI key is pinned to a forced command, so nobody without that shell could reach
it; the exposure was never a remote one, and it was still a root script run with
a caller-chosen environment. `secure_path` covers `PATH` only.

What the deploy sends, why, and how the wrapper holds each value (these are
every variable `deploy-dev.sh` and `deploy-main.sh` set on the `sudo` line, and
`compose.yaml` reads each one from the environment):

| Variable              | Why                                | dev / main wrapper accepts                   |
| --------------------- | ---------------------------------- | -------------------------------------------- |
| `MICA_PORT`           | host port compose publishes        | exactly `8676` / `8675`                      |
| `GIT_BRANCH`          | build arg, stamped into About      | exactly `dev` / `main`                       |
| `MICA_CONTAINER_NAME` | compose `container_name`           | exactly `mica-dev` / `mica-main`             |
| `MICA_IMAGE_TAG`      | compose `image`, the tag it builds | exactly `mica-dev:local` / `mica-main:local` |
| `GIT_SHA`             | build arg, stamped into About      | a full commit hash, 40 or 64 hex             |
| `MICA_CALVER`         | build arg, the release's version   | `YYYY.MM.DD.N`                               |

The smoke pair sends no variable and its rule (`/etc/sudoers.d/mica-smoke`,
above) has never carried `SETENV`, so `sudo` discards the caller's environment
for it.

**Why `env_keep` and not arguments.** Passing the values as positional arguments
would also work, and would let sudoers pin them, but it changes
`deploy-<target>.sh`, which reaches the box only through a self-install that
takes effect one deploy late (above). `env_keep` changes nothing the deploy
sends, so the unprivileged half needs no reinstall and no deploy breaks in
between. The cost of `env_keep` is that sudoers cannot constrain the _values_,
only the names, which is why the wrapper does: four of the six are constants of
the target it deploys, and it refuses anything else before it takes the lock.

**What `man sudoers` and `man sudo` confirm, and what they do not.** Confirmed
from the sudo 1.9.17 pages: `env_reset` is on by default and drops every
variable not in `env_keep` or `env_check`; `sudo(8)` says `VAR=value` on the
command line is held to "the same restrictions as existing environment
variables" and is exempted only by the `setenv` flag, the `SETENV` tag or a
command matched as `ALL`; `Defaults!<command or Cmnd_Alias>` is a documented
per-command default; `NOSETENV` is a documented tag that overrides the flag. Not
confirmed: that sudo really lets a command-line variable through on a
per-command `env_keep`, which needs a real sudo on a box where you may become
root. The pages imply it, and nothing in this repo can run it: it needs the real
setuid `sudo` and a user the box lets become root. The procedure below proves it
on hoth, with probes that start nothing, before the first real deploy depends on
it.

**Install it in this order, so that nothing breaks between the steps.** No
deploy script changes, so there is no `gphone` side to reinstall.

1. Push the commit. The deploy it triggers runs the old wrappers with the old
   rule and then goes red at the identity check, because the wrappers are stale.
   That is the check working; it is the instruction for the next step.
2. Reinstall **all three** root wrappers (every hash changed), from a checkout
   of that commit, as a user with `sudo`. **This must come before the probes:**
   an old wrapper would start a real deploy on a probe.

   ```sh
   sudo install -m 700 -o root -g root \
     scripts/deploy/mica-deploy-dev-compose.sh \
     scripts/deploy/mica-deploy-main-compose.sh \
     scripts/deploy/mica-smoke-release.sh /usr/local/sbin/
   sha256sum /usr/local/sbin/mica-*.sh scripts/deploy/mica-*.sh   # each pair must agree
   ```

   The new wrappers work under the old `SETENV` rule, and the old deploy scripts
   send values they accept.

3. Replace the sudoers file, validated first, keeping the old one:

   ```sh
   sudo cp -p /etc/sudoers.d/gphone-deploy ~/gphone-deploy.sudoers.old
   sudo visudo -cf scripts/deploy/gphone-deploy.sudoers      # must say: parsed OK
   sudo install -m 440 -o root -g root \
     scripts/deploy/gphone-deploy.sudoers /etc/sudoers.d/gphone-deploy
   sudo visudo -c                                            # every file, after
   sudo -l -U gphone                                         # what sudo believes
   ```

   Read the old file in full before replacing it (below); nothing in it but the
   two `SETENV` rules should be lost. `sudo -l -U gphone` should show
   `NOPASSWD: NOSETENV:` and, under the command-specific defaults, the six names
   in `env_keep`.

4. Prove it, as `gphone` (`sudo -u gphone -i`). The first two must be refused by
   **sudo**, before the wrapper prints anything; the third must get past sudo
   and be refused by the **wrapper**:

   ```sh
   sudo -n BASH_ENV=/home/gphone/x /usr/local/sbin/mica-deploy-dev-compose.sh
   # sorry, you are not allowed to set the following environment variables: BASH_ENV
   sudo -n MICA_PORT=8676 FOO=1 /usr/local/sbin/mica-deploy-dev-compose.sh
   # sorry, you are not allowed to set the following environment variables: FOO
   sudo -n MICA_PORT=9 GIT_BRANCH=dev GIT_SHA=x MICA_CALVER=x \
     MICA_CONTAINER_NAME=x MICA_IMAGE_TAG=x /usr/local/sbin/mica-deploy-dev-compose.sh
   # mica-wrapper: ... sha256 ...
   # REFUSED: MICA_PORT is '9', and this wrapper deploys dev with MICA_PORT=8676, nothing else
   ```

   If the first one prints the wrapper's identity line, sudo let `BASH_ENV`
   through: `SETENV` is still in force somewhere
   (`sudo grep -rn -i setenv /etc/sudoers /etc/sudoers.d`). If the third one is
   refused by **sudo**, a per-command `env_keep` does not apply the way the
   pages say: restore `~/gphone-deploy.sudoers.old` at once and see the fallback
   below.

5. Re-run the failed deploy job. It goes green only when the wrappers are
   current, and its `sudo` line is the real proof that the six names get
   through.

**The fallback**, if probe three is refused by sudo: replace the one
`Defaults!MICA_DEPLOY_COMPOSE` line with
`Defaults:gphone env_keep += "<the same six names>"`. That keeps the same six
names for every command `gphone` may run, which is wider than the command-scoped
form and still without `SETENV`; the test above will need its `Defaults!` prefix
relaxed to match.

**What the wrapper does as a second line.** Each root wrapper refuses to run,
right after its identity line, when `BASH_ENV`, `ENV`, `BASH_LOADABLES_PATH`,
`CDPATH` or `GLOBIGNORE` is set and non-empty, when `SHELLOPTS` or `BASHOPTS`
came in exported, or when an exported function (`BASH_FUNC_*%%`) was imported.
That is a detector, not a defence: **bash reads `$BASH_ENV` before it runs the
first line of the script**, so a payload has already run by the time the check
does, and the check can only stop the rest of the run and make a sudoers
regression loud. The wrappers' interpreter line is `#!/bin/bash -p`, which does
stop it: in privileged mode bash does not read `$BASH_ENV` or `$ENV`, imports no
functions and ignores `SHELLOPTS`, `BASHOPTS`, `CDPATH` and `GLOBIGNORE`. That
holds when sudo runs the file through its interpreter line (it does), and not
for `bash <file>`; the tests hold both facts. The sudoers rule is still the real
fix.

Rename the wrappers and the sudoers file has to move with them: the rules name
the commands by **exact path**, and a stale path fails as a permission error
that says nothing about renaming.

**Validate before installing, always.** A malformed file under `/etc/sudoers.d/`
takes out `sudo` itself, and you may not have another way back in:

```sh
sudo visudo -cf /tmp/gphone-deploy.new   # must say: parsed OK
sudo install -m 440 -o root -g root /tmp/gphone-deploy.new /etc/sudoers.d/gphone-deploy
sudo visudo -c                           # every file, after
```

Read the file you are replacing in full first. `grep`-ing it for the command
paths and rewriting from what matched is how the `SETENV` tag got dropped on
2026-09-04 -- a `Defaults:` line contains no command path, so it does not appear
in that grep and vanishes silently. (That was a tag that had to be there. This
is the same mistake in the other direction: a `Defaults!` line that is dropped
turns the six names into a refusal, which is loud, at the end of a build.)
`sudo -l -U gphone` prints what sudo actually believes, which is the thing to
check afterwards.

## The release smoke test

The other thing this box does for CI (MICA-220): before `release.yml` attaches
`mica-<version>.zip` to a release, it pipes the zip over SSH to a third forced
command here, and the zip is released only if it starts.

`smoke-release.sh` runs as `gphone` with the zip on stdin. It caps the size,
unpacks it into a directory of its own under `~gphone/smoke/`, checks it
unpacked to `mica/fxmanifest.lua`, and hands that directory to the root wrapper.
`mica-smoke-release.sh` then starts a throwaway MariaDB, imports the zip's own
`mica.esx.sql` into it (the release smoke only; the integration runs below
import nothing of micaOS's), and starts a throwaway FXServer from the stack's
own image with the zip's `mica` mounted read-only beside the main checkout's
`oxmysql`, in `mica_standalone` mode. The console has to print `mica started!`
within three minutes, and then, for twenty seconds more, nothing from mica or
oxmysql that reads as an error. Both containers and their network are removed on
exit, whichever way it exits, and nothing here touches either live stack: the
containers are on a network of their own and publish no port.

**Why a third key, not one of the two deploy keys.** Each deploy key is pinned
to a command that deploys. Point the workflow at one and sshd runs that, ignores
stdin, exits 0 and prints `deployed main @ <sha>` — and Actions reports a green
smoke test that tested nothing.

**Why a licence key of its own.** Without `sv_licenseKey` FXServer starts every
resource and then quits, which proves the zip loads and nothing past that. With
one the server stays up and mica's asynchronous start — the oxmysql connection,
the schema report, the orphan sweep's refusal on standalone — gets its window to
fail in. It has to be a key registered for this box and **not the one either
live stack uses**: two servers on one key will not both stay up, and the one
that loses could be the live one. The wrapper refuses to run without a key;
`MICA_SMOKE_KEYLESS=1` overrides that for a trial by hand and says so on every
line it prints.

### Installing it

Once, and none of it updates itself — `smoke-release.sh` has no checkout to
re-install from, unlike `deploy-<target>.sh`:

```sh
# the unprivileged half, as gphone
install -m 755 scripts/deploy/smoke-release.sh ~gphone/bin/smoke-release.sh

# the privileged half, root-owned so the deploy account cannot edit what it invokes
sudo install -m 700 -o root -g root \
  scripts/deploy/mica-smoke-release.sh /usr/local/sbin/

# let gphone invoke it by exact path, with a run directory as its one argument
echo 'gphone ALL=(root) NOPASSWD: /usr/local/sbin/mica-smoke-release.sh /home/gphone/smoke/*' |
  sudo tee /etc/sudoers.d/mica-smoke >/dev/null && sudo chmod 440 /etc/sudoers.d/mica-smoke

# the licence key, and anything the defaults get wrong for this box
sudo install -m 600 -o root -g root /dev/null /etc/mica-smoke.env
sudo tee /etc/mica-smoke.env >/dev/null <<'ENV'
LICENSE_KEY=<a key registered for this box, distinct from both stacks'>
# FX_IMAGE=fivem-server:latest
# DB_IMAGE=mariadb:noble
# OXMYSQL_DIR=/opt/fivem-main/server-data/vendor/oxmysql
# the integration suite's qbx run (MICA-304); default to the directories beside OXMYSQL_DIR
# OX_LIB_DIR=/opt/fivem-main/server-data/vendor/ox_lib
# QBX_CORE_DIR=/opt/fivem-main/server-data/vendor/qbx_core
# OX_INVENTORY_DIR=/opt/fivem-main/server-data/vendor/ox_inventory
ENV
```

The wrapper reads that file one named key at a time rather than sourcing it.
`FX_IMAGE` is the stack's own FXServer image (`docker images | grep server`; the
compose project `fivem` builds `fivem-server`), so the smoke test runs the
artifact the live servers run. Both images have to exist already; nothing here
pulls or builds one. On hoth the stacks are `fivem-main` and `fivem-dev`, so the
image is `fivem-main-server:latest` and the script's default of
`fivem-server:latest` does not exist there; `/etc/mica-smoke.env` sets it.

**The key has to be active, not just valid.** A key Cfx has not activated for
this box starts every resource and then fails with "Could not authenticate
server license key. Your key is inactive.", which the wrapper reports as mica
never starting. Check the key on portal.cfx.re before reading that as a broken
zip.

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
when the run is re-run with the secret in place. (Until 2026-09-29 that sentence
was false: the re-run found its own tag, took it for "already released" and
skipped every step behind a green tick. The tag step now skips only a tag with a
published release.) A tag left behind by an older commit is released by naming
it:

```sh
gh workflow run release.yml --ref dev -f tag=v2026.09.29.3
```

which builds and smoke-tests that tag's own commit and never creates a tag.
Release several oldest first, so each release's generated notes diff against the
one before it.

### Trying it by hand

From the repo, with a zip `pnpm pack:resource` produced, as any user who can run
Docker — the trust root and the settings file can be pointed elsewhere only when
the wrapper is not root:

```sh
mkdir -p /tmp/smoke/root && run=$(mktemp -d /tmp/smoke/root/XXXXXXXX)
mkdir "$run/resources" && unzip -q dist/release/mica-*.zip -d "$run/resources"
printf 'OXMYSQL_DIR=/opt/fivem/server-data/vendor/oxmysql\n' > /tmp/smoke/settings
MICA_SMOKE_KEYLESS=1 MICA_SMOKE_ROOT=/tmp/smoke/root MICA_SMOKE_ENV=/tmp/smoke/settings \
  scripts/deploy/mica-smoke-release.sh "$run"
```

On the box itself, the whole path as CI drives it:

```sh
ssh -i ~/.ssh/gphone-ci-smoke-release gphone@localhost < dist/release/mica-*.zip
```

### The integration suite (MICA-302)

The same key and the same wrapper also run an in-server test suite. CI sends
`pnpm pack:integration`'s zip, which holds `mica/` exactly as released plus a
test resource, `mica-integration/` (built from `integration/`), and the wrapper
switches to integration mode when that directory is present. It generates a
throwaway content keyring in a small `mica-keys` resource and runs the suite
**twice, one after the other, every time** (MICA-304, below): standalone, then
qbx. In each, it starts `mica` and then `mica-integration` against a database
that holds no micaOS table, which `mica` must create itself on first start
(MICA-306: the run fails unless the console says `created micaOS's schema for`
the shape that run's stack takes), and reads the suite's verdict from the
console: one `integration: PASS|FAIL|SKIP <id>` line per scenario and a final
`integration: done <P> passed <F> failed`. `release.yml` runs it before the
smoke test and will not release on a failure; `integration.yml` runs it alone on
any ref by `workflow_dispatch`.

#### Two runs, and what each proves (MICA-304)

Nothing chooses between the runs: not the zip, not the arguments, not an
environment variable (sudoers sends none). A run that could be told to leave qbx
out is one a stray edit could leave out unnoticed, so both happen on every
invocation, standalone first. A failing run ends the invocation, and every
message it prints is tagged `[standalone mode]` or `[qbx mode]`, so the CI job's
log says which one failed. The suite's own console line
`integration: mode <run>` is read back and must match.

|                                 | `standalone`                                               | `qbx`                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resources, in order             | `oxmysql`, `mica`, `mica-integration`                      | `oxmysql`, `ox_lib`, `qbx_core`, `ox_inventory`, `mica`, `mica-integration`                                                                                 |
| Database before FXServer        | empty                                                      | `qbx_core.sql` imported, then one `players` row (`ITXQBX01`, below); no micaOS table                                                                        |
| Convars                         | `mica_standalone 1`                                        | `onesync on`, `setr inventory:framework "qbx"`, `inventory:versioncheck false`, `qbx:acknowledge true`, `mica_phone_item "phone"`; **no** `mica_standalone` |
| Mounted read-only from the host | `oxmysql`                                                  | `oxmysql`, `ox_lib`, `qbx_core`, `ox_inventory`                                                                                                             |
| The console has to say          | `created micaOS's schema for ESX or standalone`            | `created micaOS's schema for qbx/qb`, and `mica: jobs -> qbx_core ...` (micaOS's bridge took qbx_core)                                                      |
| Scenarios                       | everything under `integration/scenarios/` not marked `qbx` | the six in `integration/scenarios/qbx.ts`                                                                                                                   |

The resources come from the main checkout's vendor directory, beside `oxmysql`
(`/opt/fivem-main/server-data/vendor/`), unless `/etc/mica-smoke.env` sets
`OX_LIB_DIR`, `QBX_CORE_DIR` or `OX_INVENTORY_DIR`. All four are mounted
read-only and checked, with `qbx_core.sql`, **before anything starts**: a box
missing one fails in seconds, not after the standalone run. qbx_core does not
create `players` itself and micaOS reads it, so the wrapper imports qbx_core's
own `qbx_core.sql` into the throwaway database first, then inserts one character
for the suite to look up offline. That character's values are in the wrapper
(`seed_qbx`) and in `integration/lib/qbxSeed.ts`, and
`server/__tests__/smokeWrapper.test.ts` holds the two equal. ox_inventory
creates its own table and alters `players` at start; micaOS then creates its
schema at qb width (50). FXServer gets an extra 60 seconds to print
`mica started!` in the qbx run, which loads four more resources.

A scenario belongs to one run (`mode: 'standalone' | 'qbx'`, on the line after
its `id:`). In the other run it is not quietly absent: the suite prints
`integration: SKIP <id>: needs a <mode> run, and this is the <mode> run`.
`pack:integration` writes `mica-integration/expected-scenarios.txt` as one line
per scenario per run, `<mode> pass|skip <id>`, and the wrapper holds each run to
it: the PASS lines must be **exactly** that run's scenarios and the SKIP lines
exactly the other run's. A scenario dropped from the suite, never registered for
its mode, or added without a mode fails the packer or the run, by name. A list
in the old one-id-a-line format is refused before anything starts.

**What the qbx run proves, with nobody connected:** the stack starts (qbx_core
refuses to unless `onesync` and `inventory:framework` are right); micaOS's
bridge takes qbx_core and not standalone; micaOS registered the phone as a
usable item with qbx_core (read back through `CanUseItem`, against a control);
the phone item exists in ox_inventory's item list; per-item metadata round-trips
through a temporary stash in the shapes micaOS's item-metadata seam reads
(`GetSlotsWithItem`, `SetMetadata`); an offline lookup of the seeded `players`
row answers the `charinfo` phone, both ways (`GetPhoneNumber`, `GetCitizenId`);
and the schema micaOS created on first start is 50 wide in every `citizenid`
column.

**What it cannot:** anything that needs a connected player. micaOS's own
item-metadata seam is keyed by a source and is not an export, so the stash
scenario proves ox_inventory's half of it, not micaOS's; the offline lookup
shows the phone but no export returns the name, so `charinfo`'s name is read
only from the table; a usable item actually used, online jobs and charinfo
write-back, and "delivered to an online phone" stay unproven by any suite (see
MICA-304).

**Time.** The standalone run is what the suite cost before (five to ten minutes
at most: up to 90s for the database, 180s to start, 300s for the suite). The qbx
run adds up to 90s, 240s and 300s, and in practice runs only six scenarios, so
expect it to cost a few minutes of FXServer start plus the suite's fixed three
seconds. An invocation is therefore up to about 20 minutes (570s and 630s), and
a release now holds the box for three runs (both integration runs, then the
smoke test).

**Root never touches a path `gphone` can change.** The wrapper takes hoth's lock
(`/run/mica-hoth.lock`, below) once the run directory's path is checked, pins
the run directory, copies its `resources/` into a root-owned staging directory
under `/var/lib/mica-smoke/`, refuses symlinks, hardlinks and special files, and
builds, mounts and later deletes everything from that copy. The run directory
itself is only read. Reinstall both halves after any change to either:

```sh
install -m 755 scripts/deploy/smoke-release.sh ~gphone/bin/smoke-release.sh
sudo install -m 700 -o root -g root scripts/deploy/mica-smoke-release.sh /usr/local/sbin/
```

**Reinstalling for the qbx run.** Only `mica-smoke-release.sh` changed, so only
its hash changed: install that one file (the deploy wrappers and
`compose.yaml`'s pinned hash are untouched), then run
`sha256sum /usr/local/sbin/mica-smoke-release.sh scripts/deploy/mica-smoke-release.sh`
and check that the pair agrees. Until it is reinstalled, CI's identity check
fails every integration and release job, naming the command to run. Nothing else
on the box changes: no sudoers rule, no new variable, and the resources are read
from where the live main server already has them. `/etc/mica-smoke.env` needs
nothing new.

**A key file has to sit inside a resource folder.** FXServer refuses a
resource's reads outside resource folders, with no grant to lift it, so the
suite's keyring lives in its own tiny resource. The same holds for an owner's
real key (MICA-165).

## One job at a time on hoth, and a failure that says what failed (MICA-315)

On 2026-10-06 an integration run dispatched while a dev deploy was rebuilding
the stack's image failed: the smoke wrapper printed
`smoke: starting mariadb:noble, EMPTY: ...` and then the SSH session exited 1,
with no line saying why. `set -e` had ended it at a failing docker call. A rerun
after the deploy finished passed 23/23. Two defects, two fixes, both in the same
block of text at the top of all three root wrappers (`# BEGIN wrapper-common`),
repeated in each file rather than sourced because each wrapper is one
hand-installed file. `server/__tests__/deployWrapper.test.ts` fails when the
three copies differ.

### The lock

The two deploys and the smoke and integration runs share the box's docker
daemon, its images, its networks and the smoke licence key, so they take **one
lock** and run one at a time:

| Path                  | Owner and mode      | Created by                        |
| --------------------- | ------------------- | --------------------------------- |
| `/run/mica-hoth.lock` | `root:root`, `0644` | the first wrapper to run, as root |

It is in `/run`, which only root can write, so `gphone` can neither create,
replace nor hold it. The wrapper also judges the **open file**, not the path,
and refuses (`REFUSED: ...`) a lock that is a symlink, owned by another user, or
writable by group or others. Nothing about sudoers, the forced commands or
`gphone`'s write paths changed; the file appears the first time a wrapper runs.
The old `/run/mica-smoke.lock` is no longer used and can be deleted.

It is a `flock` on a file descriptor the wrapper opens and keeps, so it is
released when the wrapper exits, on any exit, including one by signal, and it is
held **to the end of the run, cleanup included**: the smoke wrapper removes its
containers, network and staging before the next job can start. While it holds
the lock the wrapper writes one line into the file naming itself, for whoever
has to wait: `<wrapper> pid <pid> (<note>) since <UTC time>`. The note is the
run directory's name for a smoke run and `<branch>@<12 hex of the sha>` for a
deploy. The line is cleared on exit.

A job that finds the lock held says so, and on whom, and waits:

```text
mica-wrapper: mica-deploy-main-compose.sh is waiting for hoth's lock /run/mica-hoth.lock, held by: mica-smoke-release.sh pid 4242 (run7) since 2026-10-06T22:01:09Z
mica-wrapper: deploys and smoke and integration runs share this box's images, networks and licence key, so they run one at a time; waiting up to 1500s
mica-wrapper: mica-deploy-main-compose.sh got hoth's lock after 212s
```

and past the timeout it fails, loudly, having started nothing:

```text
REFUSED: gave up after 1500s waiting for hoth's lock /run/mica-hoth.lock, still held by: mica-smoke-release.sh pid 4242 (run7) since 2026-10-06T22:01:09Z. Nothing was started. If that run is stuck, find and stop it on hoth.
mica-wrapper: mica-deploy-main-compose.sh FAILED: exit status 1; the line above says why
```

**Why 1500 seconds.** A deploy holds the box for one to three minutes and an
integration run for five to ten (at most 90s for the database, 180s for FXServer
to start and 300s for the suite), and a release makes two runs back to back.
Since MICA-304 one integration invocation is two such runs under one lock (the
qbx run is allowed 90s, 240s and 300s: at most 1200s together). 1500s (25
minutes) outlasts that, so a job queued behind one invocation, and then another
job, still goes; it does not outlast two integration invocations ahead of it,
which is a backlog worth reading about. And it is far short of hanging a CI job
on a holder that is stuck. It is below the thirty minutes `deploy-<target>.sh`
waits on its own per-stack lock, so a deploy never gives up on the box before it
gives up on itself. The wait is only for jobs that reach the lock: a misuse (an
unset variable, a run directory outside the root) is refused at once, before it.

Each wrapper takes the lock before it does any work the others could disturb:
both deploys before they check or rebuild anything, the smoke wrapper before it
looks for its image (which a deploy may be rebuilding at that moment).
`deploy.yml` has a `concurrency` group of its own; it serialises deploys against
each other and nothing else, which is why the lock is on hoth and not in a
workflow: it also covers a manual run, a re-run, and any other repository using
this box.

A lock held by something that is not a wrapper, or a holder that died without
releasing (it cannot: the kernel drops a `flock` with its file descriptor),
would show as `held by: an unidentified run`. Find the process on hoth with
`sudo fuser -v /run/mica-hoth.lock`.

### A failing step names itself

Every run of every root wrapper ends with a status line, and every exit that is
not a success says what it was:

| What ended the run                            | What is printed                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| a command failed under `set -e`               | `mica-wrapper: <name> FAILED at line <n>: <the command, as written> (exit status <s>)`, then the status line |
| a deliberate refusal                          | `REFUSED: <reason>`, then the status line                                                                    |
| bash's own error, such as an unset `${VAR:?}` | bash's message, then a status line saying no step named a reason                                             |
| a signal, or an `exit 0` before the end       | `... FAILED: the run ended before it finished, so it is not a pass`                                          |
| success                                       | `mica-wrapper: <name> finished ok`                                                                           |

For example, the failure that started this, now:

```text
mica-wrapper: mica-smoke-release.sh sha256 <64 hex>
smoke: starting mariadb:noble, EMPTY: micaOS creates the schema itself on its first start
Error response from daemon: ...
mica-wrapper: mica-smoke-release.sh FAILED at line <n>: docker run -d --name "$db" --network "$net" -e MARIADB_ROOT_PASSWORD=smoke -e MARIADB_DATABASE=mica "$DB_IMAGE" > /dev/null (exit status 1)
mica-wrapper: mica-smoke-release.sh FAILED: exit status 1; the line above says why
```

The command is shown as written, with its variables unexpanded, so nothing a
variable holds (a licence key, a password) can reach the log. Only a failure in
the wrapper's own shell is reported: a failing `$(...)` is reported once, as the
assignment that ran it. The identity line is still the very first output; the
status line is the last. `finished ok` is printed only by a run that reached its
final statement: bash runs the exit trap with the status of the last command,
not the signal's, so a killed run would otherwise report itself a pass (the test
that sends it a `SIGTERM` found that).

A trial by an ordinary user can point the lock at another file and shorten the
wait with `MICA_HOTH_LOCK` and `MICA_HOTH_LOCK_TIMEOUT`, and run a compose
wrapper against a stand-in docker with `MICA_DEPLOY_COMPOSE_FILE`,
`MICA_DEPLOY_EXPECTED_SHA`, `MICA_DEPLOY_ENV_FILE` and `MICA_DEPLOY_RCON_PORT`.
**As root every one of them is ignored.** Who is root is decided on bash's own
`$EUID`, never on `id -u`: `id` is found through `PATH`, and nothing here may
depend on a caller not having chosen it (the sudoers rules carry no `SETENV`
since MICA-316, but this check was written when they did). As root the wrapper
also resets `PATH` to
`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` before its first
command, so the identity line's `sha256sum` and everything after it resolve from
a known path. A trial keeps the caller's `PATH`, since that is how its stand-in
docker is found. `deployWrapper.test.ts` runs each wrapper as uid 0 in a user
namespace (`unshare -Ur`) with a hostile `id` and `sha256sum` first on `PATH`
and every override set, and holds all of them ignored.

### Reinstalling after this change

The wrappers' bytes changed, so every hash changed: install all three, and
`compose.yaml`'s pinned `EXPECTED_SHA` is untouched. The unprivileged halves did
not change.

```sh
sudo install -m 700 -o root -g root \
  scripts/deploy/mica-smoke-release.sh \
  scripts/deploy/mica-deploy-dev-compose.sh \
  scripts/deploy/mica-deploy-main-compose.sh /usr/local/sbin/
sha256sum /usr/local/sbin/mica-*.sh scripts/deploy/mica-*.sh    # each pair must agree
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
