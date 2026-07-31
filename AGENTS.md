# AGENTS.md

**gphone** — an open-source TypeScript phone for FiveM. AGPL-3.0-or-later.

pnpm workspace, three build targets:

| Target      | Source    | Built by                            | Runtime                              |
| ----------- | --------- | ----------------------------------- | ------------------------------------ |
| Game client | `client/` | esbuild via `build/build-bundle.js` | FiveM client                         |
| Game server | `server/` | esbuild via `build/build-bundle.js` | FiveM server                         |
| UI          | `web/`    | Vite                                | CEF **and** a plain browser — see §6 |

Node 26 · Svelte **5** · Tailwind **4** · Vite 8 · Vitest 4 · Playwright 1.x
TypeScript is **split by package** — see §3. Exact versions: `pnpm list`.
`@citizenfx/client` and `@citizenfx/server` are **pinned exactly, no caret** — leave them that way.

---

## 1. Commands

`pnpm` only. Never `npm`, `npx`, `bun`, or `yarn`. Use `pnpm dlx` where you would reach for `npx`.

Run from the **repo root** unless noted.

| Task                         | Command                                      | Pre-approved?            |
| ---------------------------- | -------------------------------------------- | ------------------------ |
| Install                      | `pnpm install --frozen-lockfile`             | Yes                      |
| Format (write)               | `pnpm format`                                | Yes                      |
| Format (check)               | `pnpm format:check`                          | Yes                      |
| Typecheck **everything**     | `pnpm typecheck`                             | Yes                      |
| Typecheck one target         | `pnpm typecheck:client` · `:server` · `:web` | Yes                      |
| Unit tests                   | `pnpm test:unit`                             | Yes                      |
| E2E tests                    | `pnpm test:e2e`                              | Yes                      |
| Install browsers (first run) | `pnpm test:e2e:install`                      | Yes                      |
| Full build                   | `pnpm build`                                 | Yes                      |
| Dev (both watchers)          | `pnpm dev`                                   | Ask first — long-running |
| Any mutating git             | —                                            | **No. See §2.**          |

`pnpm typecheck` fans out to all three targets via `concurrently`. **Use it, not `pnpm typecheck:web`** —
the targets run _different TypeScript versions_ (§3), so a web-only check proves nothing about
`client/` or `server/`.

Commands the **user** runs, not you — suggest, don't invoke:

- `pnpm test:e2e:report` — HTML report
- `pnpm test:e2e:headed` — live visual run, single worker

**Formatting**: Prettier is configured root-wide with `prettier-plugin-svelte` and `prettier-plugin-tailwindcss`. Run `pnpm format` to format code across the workspace.

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
7. **SDK First.** All applications inside `web/src/modules/` and external add-ons must consume OS services (navigation, notifications, contacts, camera, registry, NUI bridge) strictly via `@gphone/sdk` hooks (`useNavigation`, `usePhoneNotification`, `useContacts`, `useCamera`, `useAppRegistry`, `useNuiBridge`). Direct relative imports into internal `web/src/store/` files from app modules are prohibited — reaching into internal shell paths breaks standalone SDK app compatibility.
8. **Never report work complete without running the §9 checklist.**

---

## 3. TypeScript is split by package — on purpose

| Package                     | Version             | Checked by                                   |
| --------------------------- | ------------------- | -------------------------------------------- |
| root (`client/`, `server/`) | **7.x** (Go-native) | `tsc --noEmit -p <target>/tsconfig.json`     |
| `web/`                      | **6.x** (JS-based)  | `svelte-check` + `tsc -p tsconfig.node.json` |

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
- **Do not use `setContext`/`getContext` as a workaround for global state.** If state needs to be accessed across disparate modules, put it in a store. Context is strictly for component library wiring (e.g., compound components).
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

- Utility classes only. A `<style>` block is acceptable _only_ for keyframes and pseudo-element
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

### Known gaps the postcss config does _not_ cover

| Feature           | Needs      | Tailwind 4 uses it for                                      |
| ----------------- | ---------- | ----------------------------------------------------------- |
| `color-mix()`     | Chrome 111 | **Every opacity modifier** — `bg-white/10`, `text-black/70` |
| `:has()`          | Chrome 105 | `has-*`, `group-has-*` variants                             |
| Container queries | Chrome 105 | `@container`, `@min-*`, `@max-*` variants                   |

`postcss-preset-env` has a `color-mix-function` transform, but it computes only static fallbacks.
Tailwind passes `var(--color-*)` arguments that cannot be resolved at build time, so the polyfill
bails exactly where it is needed. **Opacity modifiers are the highest-risk utility class here.**

For translucency, define an explicit token in `@theme` with a pre-resolved `rgb(... / ...)` value
rather than using the `/` modifier. For `:has()` or container-query behavior, use Svelte state
instead of CSS.

### Verifying in-game

Nothing in the automated suite catches this class of bug — Playwright drives a modern Chromium.
Verification is manual: `nui_devTools` in the F8 console (developer mode on), or
`http://localhost:13172/` while the game runs. Inspect the element and confirm the _computed_ value
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
