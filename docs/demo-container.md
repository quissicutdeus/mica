# The web demo container

[mica.gg](https://mica.gg/) serves two things behind one binary: a landing page
at `/`, and the phone, in a browser with no FiveM server behind it, at `/demo/`
— the NUI bundle served standalone against the mock transport. The demo is the
fastest way to show someone the phone without them installing a thing; the
landing page is what a visitor who typed the bare domain sees first, with the
demo, the docs, the latest release, and the repo one link away.

```sh
pnpm demo          # build and serve on http://127.0.0.1:8080
pnpm demo:up       # same, detached
pnpm demo:down     # stop and remove
pnpm demo:smoke    # probe a running container
```

The whole image is a few megabytes: one static binary and one directory of
static files, on `scratch`.

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

| Variable                     | Default                 | What it does                                                                  |
| ---------------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `MICA_PORT`                  | `8080`                  | Host port. The container always listens on 8080.                              |
| `TZ`                         | `America/Los_Angeles`   | The **server log** timestamps, and nothing else — see below.                  |
| `GIT_BRANCH`                 | _(Dockerfile: main)_    | Version stamp, branch half.                                                   |
| `GIT_SHA`                    | _(Dockerfile: unknown)_ | Version stamp, commit half.                                                   |
| `COMPRESS_BINARY`            | `1`                     | `0` skips UPX: ~0.5 MB larger, ~165 ms faster to start, legible to `strings`. |
| `VITE_MICA_DISABLED_APPS`    | empty (off)             | Baked into the build, same shape as `mica_disabled_apps` (see README).        |
| `VITE_MICA_DEFAULT_DOCK`     | empty (built-in dock)   | Baked into the build, same shape as `mica_default_dock` (see README).         |
| `VITE_MICA_DEFAULT_CONTACTS` | empty (off)             | Baked into the build, same shape as `mica_default_contacts` (see README).     |

The last three exist because the demo has no `server.cfg` to hold a convar in —
`pnpm --filter web build` reads them as `import.meta.env` values, the same
mechanism `VITE_MICA_ADDON_HOSTS`/`VITE_MICA_ADDON_CATALOG` already use for the
add-on catalog (`docs/addon-catalog.md`), and bakes the answer into the built
bundle rather than answering it live. A player of the demo image therefore
cannot get a different answer without a rebuild, unlike a real server, where the
convars are read live.

`shared/ownerConfig.ts`'s parsers are total — a malformed value never fails a
live server — which would otherwise make a bad build arg indistinguishable from
an unset one. `scripts/warn-owner-config.js` runs the real parsers against these
three during the image build and prints what each one rejected; it never fails
the build, since the image is still usable with the bad piece dropped.

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

## Previewing owner configuration without a rebuild

`pnpm dev`'s mock transport reads the same three names — `mica_disabled_apps`,
`mica_default_dock`, `mica_default_contacts` — as URL query parameters, so you
can try a value without rebuilding the demo image at all:

```text
http://localhost:5173/?mica_disabled_apps=camera,media&mica_default_dock=phone,,camera,messages
```

That is the fast loop for trying a value; baking one into the demo image itself
is the `VITE_MICA_*` build args above.

## Routing: `/` is the landing page, `/demo/` is the phone

`docker/serve/main.go` tells the two apart by path prefix, on the same tree and
the same binary:

- `/` serves `docker/landing/index.html` — plain hand-written HTML and CSS, no
  build step, no framework, no external request of any kind (no Google Fonts, no
  CDN script), with one screenshot copied into that directory rather than
  hotlinked. It links the demo, [docs.mica.gg](https://docs.mica.gg/), the
  [latest release](https://github.com/quissicutdeus/mica/releases/latest), and
  the repo. It is not a single-page app, so a path under `/` that is not one of
  its own files 404s — there is no client-side router to hand an unknown path
  off to.
- `/demo` (no trailing slash) redirects to `/demo/`, because every reference the
  demo bundle emits is `./relative` (`base: './'` in `web/vite.config.ts`) and
  resolves against the request's own directory — landing on `/demo` without the
  slash would resolve every one of them one level too high.
- `/demo/` and everything under it serve the phone bundle. A miss under
  `/demo/assets/` (Vite's hashed-chunk directory) is a genuine 404 — masking a
  missing chunk with an HTML 200 is how you get an unreadable "unexpected token
  '<'" in the console instead. Any other miss under `/demo/` falls back to
  `/demo/index.html`, because the phone's own navigation
  (`web/src/shell/state/navigation.ts`) is in-memory Svelte stores with no
  History API use anywhere in `web/src` — no URL but `/demo/` is ever actually
  requested by the app itself, and this is only for a visitor who typed
  something else by hand.
- Add-on bundles and the catalog the Store installs from live under
  `/demo/addons/` now, not `/addons/` — `scripts/generate-catalog.js` writes
  `bundleUrl`s with that prefix, and the Dockerfile derives
  `VITE_MICA_ADDON_CATALOG` the same way. `VITE_MICA_ADDON_HOSTS` is unaffected:
  the shell checks a fetched bundle's URL by **host**, never by path
  (`docs/addon-catalog.md`), so the path move needed no change there.

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

1. **`node:26-alpine`** builds the phone bundle with Vite into `dist/web`,
   copies the hand-written landing page from `docker/landing/` in unmodified,
   then assembles both into `dist/site` — the landing page at the root, the
   bundle under `demo/` — before writing brotli and gzip sidecars for the
   compressible files in that merged tree and **deleting the identity copy** of
   everything that got a `.gz` — about 760 KB of duplicate bytes whose only job
   was serving a client that sends no `Accept-Encoding` at all. `dist/web`
   itself never moves — `web/vite.config.ts`'s `build.outDir` is not this
   Dockerfile's to change (AGENTS.md §2.6) — only this stage's own copy of it is
   rearranged afterward, and nothing outside the image build ever reads
   `dist/site`.
2. **`golang:1-alpine`** builds `docker/serve` — stdlib only, `CGO_ENABLED=0`,
   verified static with `ldd` because a dynamically linked binary cannot run in
   the final stage — then packs it with UPX.
3. **`scratch`** takes the binary and `dist/site` as `/www`, and nothing else.

The server reads the whole tree into memory at startup. That is a few megabytes,
and it buys an ETag per encoding for free, no per-request `stat`, and no path
traversal to reason about: every lookup hits a map built by walking the tree, so
a path that is not a real file simply is not a key. It inflates the deleted
identity copies back from their `.gz` on the way in.

Two cache policies, because Vite's output splits cleanly along them.
Content-hashed files under `demo/assets/` get a year and `immutable` — the name
changes whenever the bytes do, so a stale response is not reachable. Everything
else — `demo/index.html`, which is the document that _names_ those hashed files,
and the whole landing page, which has no build step to hash it in the first
place — gets `no-cache`.

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
- The landing page and the demo bundle are two documents with two different
  fallback rules sharing one binary. So it checks both `/` and `/demo/`
  independently, asserts `/demo` redirects to `/demo/`, and asserts a stray path
  404s under the landing page but falls back to the phone under `/demo/` — the
  two are opposite behaviors and a routing regression could satisfy either check
  alone.

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
docker build -t mica-demo-test:local .   # the only way to check this locally
```

Two minutes, and it is the difference between finding this now and finding it
six pushes later. If you did not run it, say the image build is unverified
rather than reporting a green `pnpm verify` as though it covered this.

## When it will not start

The healthcheck is the server binary in a second mode (`/mica-serve -health`),
because a `scratch` image has no shell and no `wget` for the usual line. If the
container never reports healthy:

```sh
docker compose logs --no-log-prefix demo
```

A startup that dies on `/www/index.html is missing` means the landing page did
not make it into the image; `/www/demo/index.html is missing` means the web
stage produced no build. `PORT=... is not a valid port` is fatal on purpose; an
unknown `TZ` is not, and only warns.
