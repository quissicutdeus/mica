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
anything in this repo, so they are written out here rather than described:

```sh
# /etc/sudoers.d/gphone-deploy, mode 440, root:root
gphone ALL=(root) NOPASSWD:SETENV: /usr/local/sbin/mica-deploy-dev-compose.sh
gphone ALL=(root) NOPASSWD:SETENV: /usr/local/sbin/mica-deploy-main-compose.sh
```

**`SETENV:` is load-bearing and easy to drop.** `deploy-<target>.sh` passes the
compose variables inline --
`sudo MICA_PORT=8676 GIT_BRANCH=dev ... /usr/local/ sbin/mica-deploy-dev-compose.sh`
-- and setting a variable on a `sudo` command line requires that tag. Without it
sudo refuses the whole invocation with
`sorry, you are not allowed to set the following environment variables`, after
the deploy has already spent two minutes installing dependencies and building.
It is tagged per command rather than granted to the user with
`Defaults:gphone setenv`, so it reaches only these two root-owned scripts and
nothing else the account may later be allowed to run.

Rename the wrappers and this file has to move with them: the rules name the
commands by **exact path**, and a stale path fails as a permission error that
says nothing about renaming.

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
in that grep and vanishes silently. `sudo -l -U gphone` prints what sudo
actually believes, which is the thing to check afterwards.

## The release smoke test

The other thing this box does for CI (MICA-220): before `release.yml` attaches
`mica-<version>.zip` to a release, it pipes the zip over SSH to a third forced
command here, and the zip is released only if it starts.

`smoke-release.sh` runs as `gphone` with the zip on stdin. It caps the size,
unpacks it into a directory of its own under `~gphone/smoke/`, checks it
unpacked to `mica/fxmanifest.lua`, and hands that directory to the root wrapper.
`mica-smoke-release.sh` then starts a throwaway MariaDB, imports the zip's own
`mica.esx.sql` into it (the release smoke only; the integration run below
imports nothing), and starts a throwaway FXServer from the stack's own image
with the zip's `mica` mounted read-only beside the main checkout's `oxmysql`, in
`mica_standalone` mode. The console has to print `mica started!` within three
minutes, and then, for twenty seconds more, nothing from mica or oxmysql that
reads as an error. Both containers and their network are removed on exit,
whichever way it exits, and nothing here touches either live stack: the
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
throwaway content keyring in a small `mica-keys` resource, starts `mica` and
then `mica-integration` against an **empty** database, which `mica` must create
itself on first start (MICA-306: the run fails unless the console says
`created micaOS's schema for`), and reads the suite's verdict from the console:
one `integration: PASS|FAIL <id>` line per scenario and a final
`integration: done <P> passed <F> failed`. The run passes only when the PASS ids
equal `mica-integration/expected-scenarios.txt` exactly, which
`pack:integration` writes, so a scenario that silently stops running fails it.
`release.yml` runs it before the smoke test and will not release on a failure;
`integration.yml` runs it alone on any ref by `workflow_dispatch`.

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
1500s (25 minutes) outlasts two of the longest, so a job queued behind a run and
another job still goes; and it is far short of hanging a CI job on a holder that
is stuck. It is below the thirty minutes `deploy-<target>.sh` waits on its own
per-stack lock, so a deploy never gives up on the box before it gives up on
itself. The wait is only for jobs that reach the lock: a misuse (an unset
variable, a run directory outside the root) is refused at once, before it.

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
`$EUID`, never on `id -u`: `id` is found through `PATH`, and the deploy wrappers
are reached through a `SETENV` sudoers rule, so a caller may be able to hand
over a `PATH`. As root the wrapper also resets `PATH` to
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
