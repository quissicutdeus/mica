# gPhone add-on template

A standalone project that builds an installable gPhone add-on **without a clone
of the gPhone repository**. What it emits is one self-contained ES module — the
same shape `web/scripts/build-addons.mjs` emits for the add-ons that ship with
the phone — which a Store catalog entry points at and the phone loads into a
sandboxed iframe.

## Get it

```sh
pnpm dlx degit quissicutdeus/gPhone/tools/addon-template my-addon
cd my-addon
```

`degit` pulls the subdirectory out of GitHub's repository tarball; there is no
clone and no `.git` in what you get. Downloading
`https://github.com/quissicutdeus/gPhone/archive/refs/heads/dev.tar.gz` and
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

An add-on's imports resolve **two** workspace packages — `@gphone/sdk` (the
contract: hooks, UI primitives, the manifest helper, the design system) and
`@gphone/shared` (the wire vocabulary: types, routes, keybinds, rich text).
`@gphone/sdk` re-exports from `@gphone/shared` and both are `"private": true` in
gPhone's monorepo. **Neither is on npm, and there is no plan here that makes
them so.** Both are also consumed _as source_ — no build step, no `main`, no
`.d.ts` — so whatever route you get them by has to deliver TypeScript and Svelte
files that your own toolchain compiles.

The route this template takes is a **git dependency on the gPhone repository,
with the subdirectory named by `#path:`**. `pnpm` resolves that through GitHub's
codeload tarball (it does not clone), pins the resolved commit in your lockfile,
and hard-links it into your store like any other package.

```jsonc
// package.json
"dependencies": {
  "@gphone/sdk": "github:quissicutdeus/gPhone#dev&path:/sdk",
  "@gphone/shared": "github:quissicutdeus/gPhone#dev&path:/shared"
}
```

### What it costs

Five things, and none of them is hidden:

1. **`@gphone/sdk` declares `"@gphone/shared": "workspace:*"`.** That specifier
   means "the copy in gPhone's monorepo" and resolves to nothing anywhere else —
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
   "@gphone/sdk": "github:quissicutdeus/gPhone#7b58646f0c9091a14d379dbcd17ec4e8e8ef671d&path:/sdk"
   ```

   and put the same sha in the override. There is no version number worth
   pinning instead: the repository's tags are CalVer build stamps that move on
   every push, and the SDK's own `MICA_VERSION` is documented as noise for
   this purpose. `SDK_CONTRACT_VERSION` is the number that tracks the surface
   you compiled against — read it, but it is not a thing you can install.

5. **You are building gPhone's source, not a release artifact.** Your `svelte`
   and `vite` compile the SDK's 85 components. That is why they are peer
   dependencies of the SDK rather than its own: two copies of Svelte in one
   bundle means two component registries and two sets of context keys, whose
   symptom is a component that renders and then silently stops reacting.

### The routes not taken

- **npm.** Would remove every line above. It needs somebody to publish two
  packages that are currently marked private, and that is a decision about the
  project rather than about this template.
- **`pnpm pack` tarballs.** Works, and needs no network at build time — but
  `pnpm pack` rewrites `workspace:*` to a bare `1.0.0`, so you still need the
  override, _plus_ somewhere to host two `.tgz` files, _plus_ a clone to produce
  them from. Strictly more moving parts than the git dependency, for the same
  result.
- **Vendoring a copy of `sdk/` and `shared/` into your project.** No install
  ceremony at all, and no upgrade path either: you would be hand-merging an SDK
  you did not write.

## What is in here

| File                  | Why it exists                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `vite.config.ts`      | The build. Entry synthesis, the `core: true` refusal, the `@gphone/sdk/core` refusal, CSS inlining, the `__MICA_*__` guard |
| `postcss.config.js`   | Lowers CSS to Chromium 103. **Not optional** — see below                                                                     |
| `svelte.config.js`    | `vitePreprocess()`, and no `a11y` warning filter                                                                             |
| `tsconfig.json`       | Makes the typechecker resolve `@gphone/sdk` to the same barrel the build does                                                |
| `pnpm-workspace.yaml` | The override and `blockExoticSubdeps`, above                                                                                 |
| `src/manifest.ts`     | Your app's identity, tile, permissions and `core: false`                                                                     |
| `src/index.svelte`    | Your app                                                                                                                     |
| `src/Icon.svelte`     | Your launcher glyph                                                                                                          |

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

### The phone is 400x850 and never anything else

Do not write responsive CSS. Breakpoints and viewport units (`vh`, `vw`, `dvh`)
answer to the browser window, which is not the phone — the phone is a fixed-size
frame that Settings > Display scales with a single `transform`, so the layout is
identical at every size. Size against the frame: `h-full`, `flex-1`, and the
`safe-top` / `safe-bottom` insets.

Inside `Screen`, fill with **`min-h-0 flex-1`** — never `h-full`, never a bare
`flex-1`. Both fail silently and only once there is enough content to overflow.
A box that declares `overflow-y-auto` scrolls itself and is exempt. Anything
anchored to the bottom of your app must clear the home indicator
(`--spacing-home-indicator`), or its lower third sits inside a gesture bar that
sends the player home.

## The boundary you cannot build past

`@gphone/sdk/core` — `useNuiBridge`, the raw NUI transport — is refused by
`vite.config.ts` at build time, with the rule in the error message. It is
reserved for `core: true` apps that ship inside the phone. A manifest that says
`core: true` is refused for the same reason: an add-on installed from the Store
runs in a sandboxed `<iframe sandbox="allow-scripts" srcdoc>` with an opaque
origin, whose only route to the shell is `postMessage`, so the access
`core: true` claims is not access this bundle can have.

Both refusals are conveniences that fail early and say why. **The enforcing
boundary is the shell**, which re-checks every permission your manifest declares
against its own table before answering a call, and the sandbox, which gives an
add-on no NUI at all. Editing the refusals out of this file buys nothing except
a bundle that fails later and less clearly.

Reach your own server through `useService(id).call(...)`.

## Publishing it

The bundle is only half of an installable add-on; the other half is a catalog
entry served by the operator's Store backend, which carries the id, name,
version, description, the bundle URL, **a SHA-256 of the exact bytes**, the tile
colour, the permissions to show the player before they install, and any outbound
`networkHosts` your app needs. The server must also allowlist the host it is
served from. `docs/addon-catalog.md` in the gPhone repository is the
field-by-field reference.
