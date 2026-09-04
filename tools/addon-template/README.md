# micaOS add-on template

A standalone project that builds an installable micaOS add-on **without a clone
of the micaOS repository**. What it emits is one self-contained ES module — the
same shape `web/scripts/build-addons.mjs` emits for the add-ons that ship with
the phone — which a Store catalog entry points at and the phone loads into a
sandboxed iframe.

## Get it

```sh
pnpm dlx degit quissicutdeus/mica/tools/addon-template my-addon
cd my-addon
```

`degit` pulls the subdirectory out of GitHub's repository tarball; there is no
clone and no `.git` in what you get. Downloading
`https://github.com/quissicutdeus/mica/archive/refs/heads/dev.tar.gz` and
lifting the same folder out by hand does exactly as well.

## Build it

```sh
pnpm install
pnpm build     # -> dist/<your app id>.js
```

`pnpm check` runs `svelte-check` over your source if you want the typechecker as
well; the build does not run it, deliberately, so a type error never silently
costs you a bundle.

## Two packages, neither published

This is the part worth reading before you start, because every awkward line in
`package.json` and `pnpm-workspace.yaml` comes from it.

An add-on's imports resolve **two** workspace packages — `@mica/sdk` (the
contract: hooks, UI primitives, the manifest helper, the design system) and
`@mica/shared` (the wire vocabulary: types, routes, keybinds, rich text).
`@mica/sdk` re-exports from `@mica/shared` and both are `"private": true` in
micaOS's monorepo. **Neither is on npm, and that is a decision rather than an
omission** — see "Why not npm" below. Both are also consumed _as source_ — no
build step, no `main`, no `.d.ts` — so whatever route you get them by has to
deliver TypeScript and Svelte files that your own toolchain compiles.

There are two routes. Take the first unless you specifically want the second.

### Route 1: release tarballs (recommended)

Every micaOS release attaches both packages as tarballs. You get a real version
to pin, and you are not tracking a moving branch.

```jsonc
// package.json — one release, both packages
"dependencies": {
  "@mica/sdk": "https://github.com/quissicutdeus/mica/releases/download/v2026.08.31.1/mica-sdk-1.20260831.1.tgz"
}
```

```yaml
# pnpm-workspace.yaml — the SDK's own dependency on @mica/shared
overrides:
  '@mica/shared': 'https://github.com/quissicutdeus/mica/releases/download/v2026.08.31.1/mica-shared-1.20260831.1.tgz'
```

**Both tarballs, from the same release, always.** The SDK asks for an exact
`@mica/shared` version and the matching tarball is the only thing that provides
it; take them from different releases and `pnpm` tells you so rather than
installing something incoherent.

The version reads `<contract>.<yyyymmdd>.<n>`. The **major is
`SDK_CONTRACT_VERSION`** — the number your add-on branches on, which moves only
when the published surface breaks. The rest is the release's CalVer, flattened;
it is a build stamp and orders monotonically, and it does not claim to encode
"feature" versus "fix".

This route needs the one `overrides` line and nothing else. It does **not** need
`blockExoticSubdeps: false`, which route 2 does.

### Route 2: a git dependency on the repository

Use this if you need something newer than the last release — the packaged form
of the SDK moves on `dev` before it reaches a tag. `pnpm` resolves it through
GitHub's codeload tarball (it does not clone), pins the resolved commit in your
lockfile, and hard-links it into your store like any other package.

```jsonc
// package.json
"dependencies": {
  "@mica/sdk": "github:quissicutdeus/mica#dev&path:/sdk",
  "@mica/shared": "github:quissicutdeus/mica#dev&path:/shared"
}
```

### What route 2 costs

Five things, and none of them is hidden. Route 1 pays only the first, in a
simpler form: the SDK asks for an exact version rather than a workspace, so the
override is a URL and there is no `blockExoticSubdeps` to switch off.

1. **`@mica/sdk` declares `"@mica/shared": "workspace:*"`.** That specifier
   means "the copy in micaOS's monorepo" and resolves to nothing anywhere else —
   `pnpm install` fails outright with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`,
   talking about a workspace that is not yours. The `overrides` entry in
   `pnpm-workspace.yaml` redirects that one specifier at the same git source.
   **Keep its ref identical to the two above**: the SDK and the shared
   vocabulary have to come from one commit, and a mismatch is a type error at
   best and a silently wrong wire format at worst.
2. **That override is a git dependency for a *sub*dependency, which pnpm 11
   refuses by default.** Hence `blockExoticSubdeps: false`, also in
   `pnpm-workspace.yaml`. It is a supply-chain guard, it applies to your whole
   project rather than to the one override that needs it, and switching it off
   is a real cost of the situation rather than a formality.
3. **Both settings live in `pnpm-workspace.yaml` even though this is a
   one-package project.** pnpm 11 no longer reads the `pnpm` field in
   `package.json` — it warns and ignores it — so a `pnpm.overrides` block there
   looks right, changes nothing, and leaves you reading the same `workspace:*`
   error. Do not delete that file.
4. **`#dev` floats, and today it has to.** The packaged form of the SDK — `sdk/`
   as a root-level package with an `exports` map — exists only on the `dev`
   branch; `refs/heads/main` still predates it, and so does every `v2026.*` tag,
   so neither is usable here yet. Meanwhile a bare `#dev` resolves to whatever
   the branch head is on the day of your **first** install (your lockfile pins
   it after that, but a fresh clone of your project picks a new one). **Pin a
   commit as soon as you are past the first build:**

   ```jsonc
   "@mica/sdk": "github:quissicutdeus/mica#7b58646f0c9091a14d379dbcd17ec4e8e8ef671d&path:/sdk"
   ```

   and put the same sha in the override. There is no version number worth
   pinning instead: the repository's tags are CalVer build stamps that move on
   every push, and the SDK's own `MICA_VERSION` is documented as noise for this
   purpose. `SDK_CONTRACT_VERSION` is the number that tracks the surface you
   compiled against — read it, but it is not a thing you can install.

5. **You are building micaOS's source, not a release artifact.** Your `svelte`
   and `vite` compile the SDK's 85 components. That is why they are peer
   dependencies of the SDK rather than its own: two copies of Svelte in one
   bundle means two component registries and two sets of context keys, whose
   symptom is a component that renders and then silently stops reacting.

### Why not npm

Asked and answered rather than never considered. npm would remove the override
line and nothing else, and it costs more than it removes:

- **An npm name is permanent**, and unpublishing has a 72-hour window. That is a
  commitment made before there is a release process to back it.
- **It is two packages in lockstep, forever.** Every SDK release needs a
  matching `@mica/shared` release with a real range. Miss one and
  `pnpm add @mica/sdk` fails at install for everybody, not just for you.
- **micaOS is AGPL-3.0-or-later with no linking exception** — the build inlines
  the SDK into your bundle, so an add-on you distribute is a derivative work and
  carries the same licence. A one-line `pnpm add` makes it very easy to not
  notice that. Getting a tarball URL from a release page does not.

The door is not locked. If enough people are building add-ons that the override
line is the thing standing in the way, it opens.

- **Vendoring a copy of `sdk/` and `shared/` into your project** stays a bad
  idea: no install ceremony at all, and no upgrade path either — you would be
  hand-merging an SDK you did not write.

> **One caveat on route 1, stated rather than glossed.** The recipe was verified
> against local `.tgz` files, which is what `pnpm pack` produces and what the
> release job uploads. The `https://` form above has not been installed from a
> real release yet, because the release job that attaches these tarballs has not
> run on `main` at the time of writing. If it misbehaves, route 2 works today
> and is proven.

## What is in here

| File                  | Why it exists                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `vite.config.ts`      | The build. Entry synthesis, the `core: true` refusal, the `@mica/sdk/core` refusal, CSS inlining, the `__MICA_*__` guard |
| `postcss.config.js`   | Lowers CSS to Chromium 103. **Not optional** — see below                                                                 |
| `svelte.config.js`    | `vitePreprocess()`, and no `a11y` warning filter                                                                         |
| `tsconfig.json`       | Makes the typechecker resolve `@mica/sdk` to the same barrel the build does                                              |
| `pnpm-workspace.yaml` | The override and `blockExoticSubdeps`, above                                                                             |
| `src/manifest.ts`     | Your app's identity, tile, permissions and `core: false`                                                                 |
| `src/index.svelte`    | Your app                                                                                                                 |
| `src/Icon.svelte`     | Your launcher glyph                                                                                                      |

## Two things that will bite you, and no test can catch either

### FiveM's CEF is Chromium 103

Your dev browser is current; the game's embedded browser is not. Anything newer
than Chromium 103 renders perfectly everywhere you can look and is broken in
game. `:has()` (105), container queries (105), `dvh`/`svh` (108) and
`color-mix()` (111) have no fallback and must not appear in your CSS at all.

Native CSS **nesting** (112) is the exception, and it is why `postcss.config.js`
is not optional: the SDK's own `app-utilities.css` — which your bundle inlines —
nests in about thirty places. Delete that config and every one of those blocks
is dropped by CEF's parser, in game only.

Note what this means for an **inline `style=` attribute**: it never reaches
PostCSS, so a colour function past the 103 floor in one is not lowered, not
warned about, and silently dropped. Prefer a utility class from the SDK's
stylesheet.

### The phone is 400x850, the tablet is 1280x800, and neither is anything else

Do not write responsive CSS. Breakpoints and viewport units (`vh`, `vw`, `dvh`)
answer to the browser window, which is not the phone — the phone is a fixed-size
frame that Settings > Display scales with a single `transform`, so the layout is
identical at every size. The tablet is a second fixed frame, not a wider phone:
your manifest's `devices` says which you support (absent means the phone), and
an add-on that lists `'tablet'` renders its one root inside the tablet frame,
reading `useDisplay().device` to lay itself out for it. Size against the frame:
`h-full`, `flex-1`, and the `safe-top` / `safe-bottom` insets.

Inside `Screen`, fill with **`min-h-0 flex-1`** — never `h-full`, never a bare
`flex-1`. Both fail silently and only once there is enough content to overflow.
A box that declares `overflow-y-auto` scrolls itself and is exempt. Anything
anchored to the bottom of your app must clear the home indicator
(`--spacing-home-indicator`), or its lower third sits inside a gesture bar that
sends the player home.

## The boundary you cannot build past

`@mica/sdk/core` — `useNuiBridge`, the raw NUI transport — is refused by
`vite.config.ts` at build time, with the rule in the error message. It is
reserved for `core: true` apps that ship inside the phone. A manifest that says
`core: true` is refused for the same reason: an add-on installed from the Store
runs in a sandboxed `<iframe sandbox="allow-scripts" srcdoc>` with an opaque
origin, whose only route to the shell is `postMessage`, so the access
`core: true` claims is not access this bundle can have.

A third refusal reads your own code: `vite.config.ts` derives the permissions
your `@mica/sdk` imports need and fails the build if `permissions` in
`src/manifest.ts` names fewer. Declaring **more** than you use is always fine.
The mapping is the SDK's own, loaded out of the `@mica/sdk` you installed rather
than copied here, so it is the same one micaOS holds its own apps to.

Understating costs you nothing and costs the player something, which is why it
is a build error rather than a lint: your permission list is what the Store
shows before they install, and what it asks them about again when an update
widens it. An undeclared hook still throws — the shell refuses it — so the only
thing the short list changes is that the person who agreed to it was told the
wrong thing.

The first two refusals are conveniences that fail early and say why. **The
enforcing boundary is the shell**, which re-checks every permission your
manifest declares against its own table before answering a call, and the
sandbox, which gives an add-on no NUI at all. Editing the refusals out of this
file buys nothing except a bundle that fails later and less clearly — and, for
the third, a permission sheet nothing checks.

Reach your own server through `useService(id).call(...)`.

## Publishing it

The bundle is only half of an installable add-on; the other half is a catalog
entry served by the operator's Store backend, which carries the id, name,
version, description, the bundle URL, **a SHA-256 of the exact bytes**, the tile
colour, the permissions to show the player before they install, and any outbound
`networkHosts` your app needs. The server must also allowlist the host it is
served from. `docs/addon-catalog.md` in the micaOS repository is the
field-by-field reference.
