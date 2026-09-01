# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# 1. The static assets.
# ---------------------------------------------------------------------------
# Alpine is safe here specifically because pnpm-lock.yaml carries the musl
# bindings for both native pieces Vite 8 builds with -- @rolldown/binding-
# linux-x64-musl and lightningcss-linux-x64-musl. Without those in the lock,
# --frozen-lockfile on musl would fail at `vite build` with a missing binding.
FROM node:26-alpine AS web

# Every RUN below pipes. Without pipefail only the *last* command's status counts,
# so a `find` that failed would sail through as long as the `while` after it
# succeeded. Alpine's /bin/sh is busybox, so this names ash explicitly.
SHELL ["/bin/ash", "-o", "pipefail", "-c"]

# No `packageManager` field in the root package.json to corepack from, so pin to
# the major .github/workflows/build-test.yml pins (`pnpm-version: [11]`) -- the
# container and CI must not disagree about lockfile format.
RUN npm install -g pnpm@11 --no-fund --no-audit && apk add --no-cache brotli

WORKDIR /app

# Manifests only, so editing a .svelte file does not reinstall 300 packages.
# pnpm-lock.yaml has four importers -- `.`, `web`, `sdk` and `shared` -- so these
# are the complete input to the resolver. `sdk` became one in MICA-172 and
# `shared` in MICA-186; before that each was a plain directory that needed no
# manifest of its own here.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
COPY sdk/package.json ./sdk/package.json
COPY shared/package.json ./shared/package.json

# --ignore-scripts is load-bearing for two reasons:
#   1. The root package.json has `"prepare": "simple-git-hooks"`. pnpm runs the
#      root project's own lifecycle scripts, and that is NOT governed by
#      pnpm-workspace.yaml's allowBuilds/onlyBuiltDependencies (those govern
#      *dependencies*). With no .git in the context it has no git root to write
#      to. Whether it exits non-zero is version-dependent; don't bet a build.
#   2. @playwright/test is a `web` devDep whose transitive postinstall downloads
#      ~500MB of browsers, and `--filter web...` pulls web's devDeps in.
# Nothing is lost: allowBuilds already sets `esbuild: false`, so esbuild's
# postinstall does not run locally or in CI either.
#
# --filter web... drops the root devDeps entirely (typescript, vitest,
#   playwright, concurrently) -- `vite build` touches none of them.
# package-import-method=copy because the store is a cache mount on another
#   filesystem: pnpm's hardlinks would EXDEV and fall back to copying anyway,
#   one warning per package.
RUN --mount=type=cache,id=gphone-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --ignore-scripts \
      --filter web... \
      --store-dir=/pnpm/store \
      --config.package-import-method=copy

# web/vite.config.ts reaches outside web/ for three things: `import pkg from
# '../package.json'` (already copied), the @shared alias -> ../shared, and
# @gphone/sdk -> ../sdk.
#
# That third one is why the image build broke on MICA-172 and stayed broken
# for six pushes. The SDK used to live under web/src/, so `COPY web/` brought it
# along and nothing here had to name it; once it moved to a root-level package,
# every local gate still passed -- they all run against a working tree that has
# the directory -- and only the image, which is assembled from an explicit file
# list, could notice. `pnpm verify` cannot catch a missing COPY by construction.
COPY shared/ ./shared/
COPY sdk/ ./sdk/
COPY web/ ./web/
# `scripts/generate-catalog.js` runs after the build below. It reads the add-on
# manifests out of `web/src/apps` and the SDK's own `isCatalogEntry`, both already
# here, and resolves esbuild from `web` -- root devDependencies are not installed
# in this image and it must not need them.
COPY scripts/ ./scripts/

# Declared here, not at the top, so they cannot invalidate the install layers.
# getGitInfo() in web/vite.config.ts takes the env path only when BOTH are
# non-empty; otherwise it shells out to `git rev-parse`, which is exactly why
# .git stays out of the build context. GITHUB_SHA is .substring(0,7)'d, so a
# full 40-char sha is fine to pass.
ARG GIT_BRANCH=main
ARG GIT_SHA=unknown
ARG MICA_CALVER=

# No font knob here on purpose. The `gphone:trim-fonts` plugin in
# web/vite.config.ts drops the unused subsets and the legacy `.woff` fallback for
# EVERY build -- the FiveM NUI bundle carried the same 895KB of cyrillic, greek,
# math and symbols faces this image would have, so it was never a container
# problem to solve with a container flag. Change the subset list at that source
# and both builds follow.

# The demo hosts its own add-on catalog, and the origin is derived here rather
# than passed in.
#
# MICA-126 built the whole remote-install path -- fetch, host allowlist,
# SHA-256 verification, sandboxed iframe -- and left it reachable only by
# hand-writing a catalog. This image already serves the add-on bundles at
# /addons/<id>.js, so the one missing piece was a catalog beside them and two
# values telling the shell where to look. Both are empty in a stock build, which
# is MICA-126's deliberate default and is unchanged everywhere but here.
#
# Derived from GIT_BRANCH, which compose already passes, rather than added as
# build args of its own: `scripts/deploy/gphone-deploy-*-compose.sh` pin a
# sha256 of compose.yaml and refuse to deploy when it changes, and those wrappers
# are root-owned on the box and deliberately do not self-update. A new build arg
# would therefore stop both deploys until someone edited EXPECTED_SHA as root.
# This keeps compose.yaml byte-identical.
#
# An unstamped build gets no catalog rather than a failed build. A catalog entry
# needs a version and the phone's own apps do not state one, so the build stamp
# is the only honest answer -- and `pnpm demo`, or any `docker compose up --build`
# with nothing exported, supplies none. Failing there would have broken the
# ordinary local demo to serve the deployed one, so it says what it skipped and
# why instead.
RUN case "$GIT_BRANCH" in \
      main) ADDON_ORIGIN="https://gphone.site" ;; \
      dev)  ADDON_ORIGIN="https://dev.gphone.site" ;; \
      *)    ADDON_ORIGIN="" ;; \
    esac; \
    export ADDON_ORIGIN; \
    if [ -n "$ADDON_ORIGIN" ]; then \
      VITE_MICA_ADDON_CATALOG="$ADDON_ORIGIN/addons/catalog.json"; \
      VITE_MICA_ADDON_HOSTS="${ADDON_ORIGIN#https://}"; \
      export VITE_MICA_ADDON_CATALOG VITE_MICA_ADDON_HOSTS; \
    fi; \
    GITHUB_REF_NAME="$GIT_BRANCH" GITHUB_SHA="$GIT_SHA" MICA_CALVER="$MICA_CALVER" \
      pnpm --filter web build; \
    if [ -n "$ADDON_ORIGIN" ] && [ -n "$MICA_CALVER" ]; then \
      MICA_CALVER="$MICA_CALVER" \
        node scripts/generate-catalog.js "$ADDON_ORIGIN" dist/web/addons; \
    elif [ -n "$ADDON_ORIGIN" ]; then \
      echo "catalog: skipped -- MICA_CALVER is empty, so there is no version to publish."; \
      echo "catalog: the Store will list only bundled apps in this image. A stamped build"; \
      echo "catalog: (compose passes MICA_CALVER through when it is set) produces one."; \
    fi

# The catalog is generated against `dist/web/addons`, after the build rather than
# before it: `web/scripts/build-addons.mjs` empties `web/public/addons` on every
# run, so a catalog written there first is deleted, and one copied in from the
# host would carry that host's hashes. The bundles embed their own module paths
# (rolldown writes them into `//#region` comments even minified), so a bundle
# built on the box and one built here are not byte-identical -- and a catalog
# whose sha256 came from the wrong one fails every install with a hash mismatch.

# Sidecars for the server's precompressed negotiation. Deliberately not the
# .woff2 or the images -- they are already compressed, and a .br of them comes
# out larger than the original. Files under 1KB are skipped for the same reason.
# A shell loop rather than `find -exec`, because busybox gzip has no -k.
RUN set -eu; \
    find /app/dist/web -type f -size +1k \
      \( -name '*.js' -o -name '*.css' -o -name '*.html' \
         -o -name '*.svg' -o -name '*.json' -o -name '*.map' \) \
    | while IFS= read -r f; do \
        brotli -q 11 -f -o "$f.br" "$f"; \
        gzip -9 -c "$f" > "$f.gz"; \
      done

# Drop the identity copy of everything that got a .gz -- ~760KB of duplicate
# bytes. The server inflates them back into memory at startup (see load() in
# docker/serve/main.go); the gzip decoder is stdlib, so this costs no dependency
# and a few milliseconds once. Keyed off the .gz existing, so the sub-1KB files
# that skipped compression above keep their originals.
RUN set -eu; \
    find /app/dist/web -type f -name '*.gz' \
    | while IFS= read -r gz; do rm -f "${gz%.gz}"; done

# ---------------------------------------------------------------------------
# 2. The server binary.
# ---------------------------------------------------------------------------
FROM golang:1-alpine AS server

# Every RUN below pipes. Without pipefail only the *last* command's status counts,
# so a `find` that failed would sail through as long as the `while` after it
# succeeded. Alpine's /bin/sh is busybox, so this names ash explicitly.
SHELL ["/bin/ash", "-o", "pipefail", "-c"]

WORKDIR /src
COPY docker/serve/go.mod ./
COPY docker/serve/main.go ./
# Stdlib only -- no `go mod download`, no network, no lockfile. CGO_ENABLED=0 is
# what makes it static, and it also keeps the pure-Go resolver (which nothing
# here reaches anyway, since no name is ever resolved).
RUN --mount=type=cache,id=gphone-go-build,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/gphone-serve . \
 && if ldd /out/gphone-serve 2>/dev/null | grep -q '=>'; then \
      echo 'gphone-serve is dynamically linked; it cannot run in scratch' >&2; \
      exit 1; \
    fi

# Pack the binary: 6.07MB -> 2.38MB, which is the single largest saving
# available here since the binary is most of the image.
#
# `--best` and not `--lzma` on purpose. LZMA reaches 1.89MB but costs ~640ms of
# self-decompression on every exec versus ~165ms for --best, and HEALTHCHECK
# execs this binary every 30 seconds -- half a second of CPU per probe to save
# another 0.5MB is the wrong side of the trade.
#
# The cost that remains is real: ~165ms added to container start, and a packed
# binary is opaque to `strings`/`nm` and can trip heuristic AV scanners. Set
# COMPRESS_BINARY=0 to ship it plain.
ARG COMPRESS_BINARY=1
RUN if [ "$COMPRESS_BINARY" = "1" ]; then \
      apk add --no-cache upx >/dev/null && \
      upx -q --best /out/gphone-serve >/dev/null && \
      upx -qt /out/gphone-serve >/dev/null; \
    fi

# ---------------------------------------------------------------------------
# 3. The image: one binary and one directory.
# ---------------------------------------------------------------------------
FROM scratch

LABEL org.opencontainers.image.source="https://github.com/quissicutdeus/gphone"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"
LABEL org.opencontainers.image.description="gPhone NUI bundle, served standalone in mock mode"

COPY --from=server /out/gphone-serve /gphone-serve
COPY --from=web    /app/dist/web     /www

# Numeric on purpose. A named USER would mean shipping an /etc/passwd whose only
# job is translating a name this image never prints back into this same number.
# 8080 is above 1024, so no capability is involved either.
USER 65532:65532

ENV PORT=8080

# The zone database is compiled into the binary (`import _ "time/tzdata"` in
# docker/serve/main.go), so this needs no tzdata package and no
# /usr/share/zoneinfo -- the image is still one binary and one directory.
#
# Override per run with `-e TZ=Europe/Berlin`. Note that bind-mounting
# /etc/localtime will NOT win against this: Go consults /etc/localtime only when
# $TZ is unset, and this line always sets it. To follow the host instead, pass
# the host's own zone explicitly -- see docs/demo-container.md.
#
# This only moves the server's log timestamps. The phone's clock and every
# message timestamp are rendered in the browser from the *viewer's* system zone.
ARG TZ=America/Los_Angeles
ENV TZ=${TZ}

EXPOSE 8080

# JSON array = exec form. The string form needs a shell to parse it and there is
# none here -- `HEALTHCHECK CMD wget ...` is the usual thing written on this line
# and it cannot work. The probe is a mode of the server binary instead.
HEALTHCHECK --interval=30s --timeout=3s --start-period=2s --retries=3 \
  CMD ["/gphone-serve", "-health"]

ENTRYPOINT ["/gphone-serve"]
