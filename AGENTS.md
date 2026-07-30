# AGENTS.md

> Lives at the **repo root**. Not in `.agents/` — that directory is for skills, workflows, and
> custom agents; an `AGENTS.md` placed there is not discovered.

**gphone** — an open-source TypeScript phone for FiveM. AGPL-3.0-or-later.

pnpm workspace, three build targets:

| Target | Source | Built by | Runtime |
|---|---|---|---|
| Game client | `client/` | esbuild via `build/build-bundle.js` | FiveM client |
| Game server | `server/` | esbuild via `build/build-bundle.js` | FiveM server |
| UI | `web/` | Vite | CEF **and** a plain browser — see §6 |

Node 26 · Svelte **5** · Tailwind **4** · Vite 8 · Vitest 4 · Playwright 1.x
TypeScript is **split by package** — see §3. Exact versions: `pnpm list`.
`@citizenfx/client` and `@citizenfx/server` are **pinned exactly, no caret** — leave them that way.

---

## 1. Commands

`pnpm` only. Never `npm`, `npx`, `bun`, or `yarn`. Use `pnpm dlx` where you would reach for `npx`.

Run from the **repo root** unless noted.

| Task | Command | Pre-approved? |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | Yes |
| Typecheck **everything** | `pnpm typecheck` | Yes |
| Typecheck one target | `pnpm typecheck:client` · `:server` · `:web` | Yes |
| Unit tests | `pnpm test:unit` | Yes |
| E2E tests | `pnpm test:e2e` | Yes |
| Install browsers (first run) | `pnpm test:e2e:install` | Yes |
| Full build | `pnpm build` | Yes |
| Dev (both watchers) | `pnpm dev` | Ask first — long-running |
| Any mutating git | — | **No. See §2.** |

`pnpm typecheck` fans out to all three targets via `run-p`. **Use it, not `pnpm typecheck:web`** —
the targets run *different TypeScript versions* (§3), so a web-only check proves nothing about
`client/` or `server/`.

Commands the **user** runs, not you — suggest, don't invoke:
- `pnpm test:e2e:report` — HTML report
- `pnpm test:e2e:headed` — live visual run, single worker

**There is no linter or formatter in this repo.** Do not invent `pnpm lint` or `pnpm format`, and do
not add one without asking.

---

## 2. Hard constraints

Not negotiable. If a task appears to require breaking one, **stop and ask** — do not work around it.

1. **No mutating git.** `git status`, `git diff`, `git log` are fine. Never `add`, `commit`, `push`,
   `checkout`, `reset`, `stash`, `rebase`, or `branch`.
2. **Never edit `fxmanifest.lua` or anything in `dist/`.** Both are generated — the manifest by
   `scripts/generate-manifests.js`, `dist/` by the build. Edits are erased by the next `clearbuild`.
   Change the generator instead.
3. **Never delete or "simplify" `web/postcss.config.js`.** It looks redundant next to Tailwind 4.
   It is not. See §6 — removing it breaks every color in-game while the dev browser looks perfect.
4. **Never pass unsanitized user content to `{@html}`.** See §7.
5. **No new dependencies** without asking.
6. **Do not change** TypeScript versions in either package, Vite `build.outDir`, or
   `scripts/generate-manifests.js` output paths without asking.
7. **Never report work complete without running the §9 checklist.**

---

## 3. TypeScript is split by package — on purpose

| Package | Version | Checked by |
|---|---|---|
| root (`client/`, `server/`) | **7.x** (Go-native) | `tsc --noEmit -p <target>/tsconfig.json` |
| `web/` | **6.x** (JS-based) | `svelte-check` + `tsc -p tsconfig.node.json` |

Deliberate, not drift. TypeScript 7.0 ships without a stable programmatic compiler API, and
`svelte-check` (via `svelte2tsx`) requires it; that API lands in 7.1. `client/` and `server/` are
plain `tsc` with no Svelte involvement, so they get the native compiler now and `web/` waits.

- **Do not "align" the versions.** Bumping `web/` to 7 breaks `pnpm typecheck:web`. Dropping root to
  6 discards the reason the split exists.
- **`client/` and `server/` are checked more strictly than `web/`.** TS 7 makes `strict` and the 6.0
  deprecations hard defaults. Code that passes in `web/` may fail in `client/`.
- **`@shared/types` is a tsconfig path alias, not a workspace package.** It appears in no
  `dependencies` block and `pnpm add @shared/types` will fail. TS 7 removed `baseUrl`, so path
  mappings in `client/` and `server/` must be relative to their own tsconfig.
- **`client/` and `server/` are plain directories**, not workspace packages — they share root's
  `node_modules`. Only `web/` is a separate pnpm project.
- **Editor errors may disagree with CLI errors** in `web/`, because the language service picks one
  TypeScript for the whole workspace. **The CLI is authoritative.** If `pnpm typecheck` is clean,
  the code is clean regardless of editor squiggles.
- When 7.1 ships, the migration is: bump `svelte-check`, bump `web/` to 7, delete this section.

---

## 4. Svelte 5 — state policy

Svelte 5 is installed, so runes (`$state`, `$derived`, `$effect`) are available. **This repo does not
use them for global state.** Global state is `writable` / `derived` stores in `web/src/store/`, one
file per domain (`contacts.ts`, `messages.ts`).

- Cross-component / cross-module state → **stores**, in `web/src/store/`.
- Component-local state → runes are fine, inside `.svelte` files.
- **Do not** introduce `.svelte.ts` rune-based state modules, and do not convert existing stores to
  runes. Stores are not deprecated in Svelte 5 and the codebase is currently consistent.
- **Do not mix idioms within a single file.**

No external state libraries — no Redux, Zustand, XState, Nanostores.

> Migrating to runes wholesale is legitimate, but it is a decision to make and record here first.
> A half-migrated codebase is the failure mode this rule exists to prevent.

---

## 5. Styling

Tailwind 4 via `@tailwindcss/vite`. **There is no `tailwind.config.js` and you must not create
one** — a JS config in a v4 CSS-first project is ignored, so the symptom is "my theme change did
nothing," with no error anywhere. Theme customization goes in CSS: `@import "tailwindcss"` plus
`@theme { ... }`.

- Utility classes only. A `<style>` block is acceptable *only* for keyframes and pseudo-element
  cases Tailwind cannot express. No CSS modules, no styled-components.
- Prefer scale tokens over arbitrary values (`p-4`, not `p-[17px]`) unless matching a fixed design.
- **No visible scrollbars.** Scrollbars must never be visible anywhere inside the phone interface. Global CSS rules in `web/src/app.css` (`scrollbar-width: none` / `::-webkit-scrollbar { display: none }`) enforce this across all scrollable containers.
- **Read §6 before writing any color, layout, or variant utility.** Tailwind 4 targets a browser
  several years newer than the one this UI actually runs in.

---

## 6. The CEF capability baseline — read this before touching CSS

Every line of `web/` code must run in a plain browser with mock data **and** in FiveM's CEF. The two
are not equivalent, and the gap is wider than it looks:

**FiveM's release CEF is Chromium 103. Tailwind 4's baseline is Chromium 111.**

Your dev browser is current. The game is eight major versions below Tailwind's floor. Anything in
that gap renders correctly in `pnpm dev`, passes Playwright, and is broken in-game.

### Why `web/postcss.config.js` exists

It transforms `oklab()`/`oklch()` — Tailwind 4's entire default palette — to a supported fallback,
with `preserve: true` so modern engines still get the original. It is the only reason colors render
in-game. Load-bearing infrastructure, not leftover Tailwind 3 config. `autoprefixer` alongside it is
mostly redundant under Tailwind 4 but harmless; leave it.

### Known gaps the postcss config does *not* cover

| Feature | Needs | Tailwind 4 uses it for |
|---|---|---|
| `color-mix()` | Chrome 111 | **Every opacity modifier** — `bg-white/10`, `text-black/70` |
| `:has()` | Chrome 105 | `has-*`, `group-has-*` variants |
| Container queries | Chrome 105 | `@container`, `@min-*`, `@max-*` variants |

`postcss-preset-env` has a `color-mix-function` transform, but it computes only static fallbacks.
Tailwind passes `var(--color-*)` arguments that cannot be resolved at build time, so the polyfill
bails exactly where it is needed. **Opacity modifiers are the highest-risk utility class here.**

For translucency, define an explicit token in `@theme` with a pre-resolved `rgb(... / ...)` value
rather than using the `/` modifier. For `:has()` or container-query behavior, use Svelte state
instead of CSS.

### Verifying in-game

Nothing in the automated suite catches this class of bug — Playwright drives a modern Chromium.
Verification is manual: `nui_devTools` in the F8 console (developer mode on), or
`http://localhost:13172/` while the game runs. Inspect the element and confirm the *computed* value
resolved, not just that the declaration is present.

A CEF upgrade (M140/M144) is in progress upstream but not in the release client. Until it ships,
assume Chromium 103.

### Other CEF constraints

- The app wrapper keeps `bg-transparent`. The game renders behind the phone overlay; an opaque
  background blacks out the player's screen.
- Never use `window.location`, `window.open`, or anchor navigation. A redirect reloads the entire CEF
  instance and drops all state. Navigate internally via Svelte components.
- Resources are served over `https://cfx-nui-<resource>/`, not `nui://`.

---

## 7. Untrusted content and `{@html}`

Player-supplied strings — message bodies, contact names, note contents — must never reach `{@html}`
unsanitized. `marked` passes raw HTML through by default and has no built-in sanitizer.

- Render user content only via the sanitizing helper in `web/src/utils/markdown.ts`. Never call
  `marked.parse()` directly in a component.
- Never add `a` to the DOMPurify allowlist. Anchor navigation reloads the CEF instance and drops all
  state, so a link in a message body is a griefing vector.
- Error branches must sanitize too. Returning raw input on a parse failure is a wider hole than the
  success path.

Why this is sharper in CEF than on the web: injected script can `fetch` against
`https://<resource>/<event>` and invoke any registered NUI callback, including ones with server-side
effects. XSS here is privilege escalation, not just defacement.

---

## 8. Repo layout, NUI, and testing

```
client/          # game client TS — own tsconfig, TS 7
server/          # game server TS — own tsconfig, TS 7
web/             # the UI (Vite + Svelte 5, TS 6). "--filter web" targets this.
  e2e/               # Playwright specs
  src/
    components/      # shared, presentational, app-agnostic
    modules/<app>/   # one folder per phone app: screens + local logic
    store/           # global state, one file per domain
    mocks/
      registry.ts    # MockRegistry — browser-mode NUI handlers
      data.ts        # fixtures
    utils/
      fetchNui.ts    # the ONLY path to the game client
      markdown.ts    # the ONLY sanitizing renderer — see §7
  *.test.ts          # Vitest, colocated with source
  postcss.config.js  # load-bearing — see §6
  playwright.config.ts
build/           # build-bundle.js — esbuild pipeline for client + server
scripts/         # generate-manifests.js — GENERATES fxmanifest.lua
dist/            # generated. Never edit. Wiped by clearbuild.
```

Place new UI code by asking: reusable across apps (`components/`), specific to one app
(`modules/<app>/`), or global state (`store/`)?

**NUI communication**
- All calls to the game go through `fetchNui()` in `web/src/utils/fetchNui.ts`, which wraps
  `fetch('https://<resource>/<event>')`. Never call `fetch` at a game endpoint directly.
- When `isBrowser()` is true, `fetchNui` resolves from the MockRegistry in
  `web/src/mocks/registry.ts`.
- **Adding a NUI event is a two-file change**: the call site *and* a handler in `registry.ts`. A
  missing handler makes the feature untestable in browser mode and invisible to Playwright.
  Fixtures go in `web/src/mocks/data.ts`.

**Unit tests** — Vitest, colocated as `*.test.ts` beside the source (`src/store/contacts.test.ts`).
New store logic and new `fetchNui` handlers get tests.

**E2E and the dev server**
- Config is `web/playwright.config.ts` — read it rather than assuming ports or flags. Locally it
  reuses an already-running dev server; in CI it always spawns its own.
- **Never kill or restart a dev server you did not start.** The user may have one running.
- When reusing, E2E tests whatever state that server is in, including uncommitted edits and stale
  HMR. If results look impossible, ask the user to restart it before debugging the test.
- A reused dev server is not a production bundle. A green E2E run says nothing about `vite build`
  output, and nothing at all about CEF (§6).
- The `PORT` env var in the Playwright config is **not** wired through to Vite. Do not rely on it.
- Assume standard `localhost` routing (WSL2 NAT).

**Build-output coupling**
- Vite's `build.outDir` must stay in sync with the `ui_page` and `files[]` values that
  `scripts/generate-manifests.js` writes into `fxmanifest.lua`. A mismatch produces a blank phone
  in-game with **no console error**.
- `pnpm build` runs `clearbuild → typecheck → generate-manifests → build-bundle → build:web`.
  Changing that order breaks assumptions in the manifest step.

---

## 9. Definition of done

Before reporting any task complete, run these and report the actual output:

1. `pnpm typecheck` — all three targets, zero errors
2. `pnpm test:unit` — confirm the summary reads `0 failed`
3. E2E, if UI behavior changed — confirm `0 failed`
4. If a NUI event was added — confirm the MockRegistry handler exists
5. If user-facing content rendering changed — confirm it routes through `markdown.ts` (§7)
6. If build config or the manifest generator was touched — run `pnpm build` and confirm the emitted
   `fxmanifest.lua` paths match the actual `dist/` contents
7. **If CSS changed** — state plainly that in-game verification is outstanding and name the specific
   features used that fall in the §6 gap. Do not claim a visual change works in CEF; you cannot
   observe that from here.

**Read the full output, including individual failure traces.** Do not infer success from the absence
of a crash, from an exit code alone, or from a truncated log. If you did not see `0 failed`, the
tests did not pass. Note that `run-p` interleaves output from three typecheckers running two
different TypeScript versions — scan for errors from *each* one, not just the last block printed.

Report honestly: what you ran, what passed, what failed, what you did not verify. An accurate
"typecheck clean, unit tests pass, E2E has one failure in contacts.spec.ts" is far more useful than
an optimistic "done."

---

## 10. When you are blocked

Stop and ask if a task requires violating §2, contradicts something in this file, fails for a reason
you do not understand, or needs a new dependency.

Do not disable a test, add `@ts-expect-error`, widen a type to `any`, delete an assertion, or bypass
a guard to make something pass. Surface the conflict instead.