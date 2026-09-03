# The web demo container

The phone, in a browser, with no FiveM server behind it — the NUI bundle served
standalone against the mock transport. It is what runs at
[gphone.site](https://gphone.site/), and it is the fastest way to show someone
the phone without them installing a thing.

```sh
pnpm demo          # build and serve on http://127.0.0.1:8080
pnpm demo:up       # same, detached
pnpm demo:down     # stop and remove
pnpm demo:smoke    # probe a running container
```

The whole image is **3.62 MB**: one static binary and one directory of static
files, on `scratch`.

This is not a development loop. There is deliberately no bind mount and no live
reload — `pnpm dev` already does that far better than a container round-trip
could (see [dev-loop.md](dev-loop.md)). What this composes is the _shipped
artifact_, which is a different question: does the thing that leaves the
building actually serve.

## Stamping a real version

Settings > About shows the build it came from. `.dockerignore` keeps `.git` out
of the build context on purpose, so `web/vite.config.ts` cannot fall back to
`git rev-parse` inside the container and produce a stale-but-plausible answer.
Pass it explicitly:

```sh
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD) \
GIT_SHA=$(git rev-parse HEAD) \
  pnpm demo
```

Without them you get `v1.0.0 (main@unknown)` — honestly wrong rather than
quietly wrong.

## Knobs

| Variable          | Default                 | What it does                                                                  |
| ----------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `GOS_PORT`        | `8080`                  | Host port. The container always listens on 8080.                              |
| `TZ`              | `America/Los_Angeles`   | The **server log** timestamps, and nothing else — see below.                  |
| `GIT_BRANCH`      | _(Dockerfile: main)_    | Version stamp, branch half.                                                   |
| `GIT_SHA`         | _(Dockerfile: unknown)_ | Version stamp, commit half.                                                   |
| `COMPRESS_BINARY` | `1`                     | `0` skips UPX: ~0.5 MB larger, ~165 ms faster to start, legible to `strings`. |

`TZ` moves the server's log lines only. The phone's clock and every message
timestamp are rendered in the browser from the **viewer's** own system zone, so
a visitor in Berlin sees Berlin time no matter what this container is set to.
The IANA database is compiled into the binary, so any zone name works with no
`tzdata` package present. Bind-mounting `/etc/localtime` will **not** win — Go
consults it only when `$TZ` is unset, and the image always sets it. To follow
the host, pass its zone:

```sh
TZ=$(readlink /etc/localtime | sed 's#.*/zoneinfo/##') pnpm demo
```

## It binds to loopback

`compose.yaml` publishes `127.0.0.1:8080`, not the conventional `8080:8080`. A
bare mapping reaches every interface on the machine, and Docker writes those
rules into DNAT chains that a host firewall's INPUT rules never inspect — so the
demo would be quietly reachable from the network by anyone who ran `pnpm demo`
on a laptop. Exposing it should be an edit someone makes deliberately, in a
deployment, not a default that surprises them.

The container also runs read-only, with every capability dropped,
`no-new-privileges`, and an unprivileged numeric uid. None of that costs
anything here: the image never writes, never execs, and never resolves a name.

## What is actually in it

Three stages, in `Dockerfile`:

1. **`node:26-alpine`** builds the assets, then writes brotli and gzip sidecars
   for the compressible ones and **deletes the identity copy** of everything
   that got a `.gz` — about 760 KB of duplicate bytes whose only job was serving
   a client that sends no `Accept-Encoding` at all.
2. **`golang:1-alpine`** builds `docker/serve` — stdlib only, `CGO_ENABLED=0`,
   verified static with `ldd` because a dynamically linked binary cannot run in
   the final stage — then packs it with UPX.
3. **`scratch`** takes the binary and `/www`, and nothing else.

The server reads the whole tree into memory at startup. That is a few megabytes,
and it buys an ETag per encoding for free, no per-request `stat`, and no path
traversal to reason about: every lookup hits a map built by walking the tree, so
a path that is not a real file simply is not a key. It inflates the deleted
identity copies back from their `.gz` on the way in.

Two cache policies, because Vite's output splits cleanly along them.
Content-hashed files under `assets/` get a year and `immutable` — the name
changes whenever the bytes do, so a stale response is not reachable.
`index.html` gets `no-cache`, because it is the document that _names_ those
hashed files, and caching it is precisely how you pin a client to a dead build.

## Gates

`docker build` succeeding proves the image assembles, not that it serves.

```sh
pnpm lint:container   # gofmt, go vet, go build, hadolint
pnpm demo:up && pnpm demo:smoke
```

`lint:container` reads what `pnpm format:check` cannot: Prettier has no parser
for Go or for a Dockerfile, and knip does not scan them. If `go` or `hadolint`
is not on your PATH it runs the same checks in a container instead — anyone
working on this image already has Docker — and only reports **skipped** when
neither is available. A skip is not a pass. `--no-docker` forces the local
binaries; CI passes `--require`, which turns a skip into a failure, and that is
what keeps "skipped locally" from becoming "skipped everywhere".

`demo:smoke` is a regression list, not a checklist. Every assertion in it is one
that failed for real while this was being built:

- Font pruning once outran the CSS that named the fonts, leaving 56 `url()`s
  pointing at 404s. So it walks every reference in the HTML **and** every
  `url()` in every stylesheet.
- Go's MIME table has no `.woff2` and compensates by reading `/etc/mime.types`,
  which does not exist in a `scratch` image. So it asserts the font content-type
  explicitly.
- The image ships no identity copy of anything compressible. So it asserts that
  all three encodings decode to **identical bytes**, which is the only thing
  that proves the startup inflation is correct rather than merely non-crashing.

Both run in CI as a separate `container` job — separate because the main
`verify` job runs inside the Playwright image, which has no Go toolchain, no
hadolint and no Docker daemon.

### The one thing `pnpm verify` does not cover

That CI job **builds the image**. `pnpm verify` never does — `lint:container`
lints the Dockerfile, it does not run it — so the image build is the single gate
whose verdict cannot be reached from a developer's terminal by any local
command. AGENTS.md §9 points here for exactly that reason.

It matters more than the size of the exception suggests, because of what the
image is: the only artifact assembled from an **explicit file list** rather than
from whatever happens to be on disk. `.dockerignore` denies everything and
re-admits an allowlist; the Dockerfile then `COPY`s named paths. Every local
gate runs against a working tree that already contains every file, so a path
missing from either list is invisible to all of them — and an allowlist that has
gone stale does not announce itself, it just silently stops including something.

This is not hypothetical. MICA-172 moved the SDK from `web/src/sdk/` to a
root-level `sdk/` package. Before the move `COPY web/` carried it and neither
list had to name it; after, neither did. `pnpm verify` stayed green and the
image build failed on `Could not resolve '/app/sdk/app.css'` for **six
consecutive pushes to `dev`** before anyone read the CI result.

So, when a change adds or moves a top-level directory that `web/` builds
against, or adds a file the bundle reads at build time:

```sh
docker build -t gos-demo-test:local .   # the only way to check this locally
```

Two minutes, and it is the difference between finding this now and finding it
six pushes later. If you did not run it, say the image build is unverified
rather than reporting a green `pnpm verify` as though it covered this.

## When it will not start

The healthcheck is the server binary in a second mode (`/gos-serve -health`),
because a `scratch` image has no shell and no `wget` for the usual line. If the
container never reports healthy:

```sh
docker compose logs --no-log-prefix demo
```

A startup that dies on `/www/index.html is missing` means the web stage produced
no build. `PORT=... is not a valid port` is fatal on purpose; an unknown `TZ` is
not, and only warns.
