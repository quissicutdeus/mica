# AGENTS.md

**micaOS** — an open-source TypeScript phone and tablet OS for FiveM.
AGPL-3.0-or-later.

pnpm workspace, three build targets:

| Target      | Source    | Built by                            | Runtime                              |
| ----------- | --------- | ----------------------------------- | ------------------------------------ |
| Game client | `client/` | esbuild via `build/build-bundle.js` | FiveM client                         |
| Game server | `server/` | esbuild via `build/build-bundle.js` | FiveM server                         |
| UI          | `web/`    | Vite                                | CEF **and** a plain browser — see §6 |

Node 26 · Svelte **5** · Vite 8 · Vitest 4 · Playwright 1.x TypeScript is
**split by package** — see §3. Exact versions: `pnpm list`. `@citizenfx/client`
and `@citizenfx/server` are **pinned exactly, no caret** — leave them that way.

**This file is what is true for every task.** Detail true for only one kind of
work lives in a skill (`.claude/skills/`, listed in `CLAUDE.md`) or a doc, and
each section below points at the one that holds it — a pointer means the rule is
still in force, one file away, never that it stopped applying. **This file is
capped at 40,000 characters** and `pnpm lint:agents` (a `pnpm verify` gate)
fails above it, warning first — new detail goes to a skill or a doc, with a
pointer left here.

---

## 1. Commands

`pnpm` only — never `npm`, `npx`, `bun`, or `yarn`; use `pnpm dlx` for `npx`.
Run from the **repo root** unless noted.

| Task                                              | Command                                                                | Pre-approved?            |
| ------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------ |
| **Every gate, in order**                          | **`pnpm verify`**                                                      | Yes                      |
| Every gate except e2e                             | `pnpm verify --quick`                                                  | Yes                      |
| Fast loop: format + typecheck + changed unit only | `pnpm check:fast`                                                      | Yes                      |
| Fail fast if no dev server is warm                | `pnpm dev:check`                                                       | Yes                      |
| Lint the Go server and the Dockerfile             | `pnpm lint:container`                                                  | Yes                      |
| Actions SHA-pinned and no major behind            | `pnpm lint:actions`                                                    | Yes                      |
| Run the demo image locally                        | `pnpm demo` / `demo:up` / `demo:down`                                  | Yes                      |
| Smoke-test a running demo image                   | `pnpm demo:smoke`                                                      | Yes                      |
| Scaffold an app                                   | `pnpm new:app <id> [--service]`                                        | Yes                      |
| Install                                           | `pnpm install --frozen-lockfile`                                       | Yes                      |
| Format (write)                                    | `pnpm format`                                                          | Yes                      |
| Format (check)                                    | `pnpm format:check`                                                    | Yes                      |
| Dead code scan                                    | `pnpm deadcode`                                                        | Yes                      |
| Typecheck **everything**                          | `pnpm typecheck`                                                       | Yes                      |
| Typecheck one target                              | `pnpm typecheck:client` · `:server` · `:integration` · `:web` · `:sdk` | Yes                      |
| Unit tests **everything**                         | `pnpm test:unit`                                                       | Yes                      |
| Unit tests one project                            | `pnpm test:unit:web` · `:server`                                       | Yes                      |
| E2E tests                                         | `pnpm test:e2e`                                                        | Yes                      |
| Install browsers (first run)                      | `pnpm test:e2e:install`                                                | Yes                      |
| Generate per-app SQL                              | `pnpm generate:sql`                                                    | Yes                      |
| Generate + dev reset SQL                          | `pnpm generate:sql:reset`                                              | Ask first — destructive  |
| Regenerate locale catalogs                        | `pnpm generate:locales`                                                | Yes                      |
| Full build                                        | `pnpm build`                                                           | Yes                      |
| Dev (both watchers)                               | `pnpm dev`                                                             | Ask first — long-running |
| Commit / push on `dev` or a ticket branch         | —                                                                      | Yes — see §2.1           |
| Force-push, move `main`, change protection        | —                                                                      | **Ask first. See §2.1.** |

`pnpm typecheck` fans out to all five targets via `concurrently`. **Use it, not
`pnpm typecheck:web`** — the targets run different TypeScript versions; §3 has
why.

Commands the **user** runs, not you — suggest, don't invoke:

- `pnpm test:e2e:report` — HTML report
- `pnpm test:e2e:headed` — live visual run, single worker

**Formatting**: Prettier is configured root-wide with `prettier-plugin-svelte`.
Run `pnpm format` to format code across the workspace.

### In-game commands

`micaschema`, `micamedia`, `micacharge`, `micaseed`, `micacall`, `micaimport`
and `micacrypt`. The first five are admin-gated by `isAdmin` in
`server/services/Admin.ts`; `micaimport` and `micacrypt` skip that gate entirely
and instead refuse any `source` but the console. **`micaschema apply`** (changes
a live schema, §8), **`micamedia prune`** (deletes rows), **`micaimport`**
(reads and writes every player's rows, MICA-233) and **`micacrypt`** (the
content key and the backfill that re-seals every body, MICA-165) take the server
console and nobody else. Every command, its gating, arguments and dry run:
[`docs/in-game-commands.md`](docs/in-game-commands.md).

### The two Vitest projects

`pnpm test:unit` fans out to **two separate, non-interchangeable Vitest
projects**: `web/src/**` and `sdk/**` run under `web/vite.config.ts` (the SDK
has no project of its own); `server/__tests__/` and `client/__tests__/` run
under the root `vitest.config.ts`, node environment, no plugins, no globals.

Both tsconfigs exclude `server/__tests__/`, so **server tests are not
typechecked** — `pnpm test:unit:server` is the only thing that validates them.
`server/__tests__/setup.ts` stubs the FiveM globals (`exports`, `onNet`,
`emitNet`, `source`) that server modules touch at import time. **Mock
`../lib/Database` in any suite that loads a repository** — it reads
`exports.oxmysql` in module scope and must never reach a real connection.

### The fast local loop

`pnpm verify` is the gate (§9), not a per-edit habit — a cold run costs minutes.
`pnpm check:fast` is the named middle ground and what the pre-push hook runs;
`pnpm verify --quick` (or `verify:quick`) is the CI-grade check before opening a
PR, and skips only e2e. `pnpm dev:check` fails fast if `pnpm dev` isn't warm;
it's a courtesy, not a prerequisite.

[`docs/dev-loop.md`](docs/dev-loop.md) has the per-file commands, the
`--changed` caveat that makes `check:fast` run the whole suite while
`package.json` is in your diff, Playwright's timeout escape hatch, why
`pnpm test:unit` costs what it costs, and how to prune `.claude/worktrees/`.

---

## 2. Hard constraints

Not negotiable. If a task appears to require breaking one, **stop and ask** — do
not work around it.

1. **Git: commit and push freely on `dev`.** `add`, `commit`, `push`,
   `checkout`, `branch` and `stash` on `dev` or a ticket branch need no
   permission — this is a solo project, and asking per-command only cost round
   trips.

   **Stop and ask** before any of these, hard to undo or reaching further than
   the working tree: a force-push or any rewrite of already-pushed history;
   `reset --hard` over uncommitted work; anything that moves `main`; changing
   branch protection or repository settings; `--no-verify`. Say what you're
   about to do and why, then wait. §2.10's attribution ban is absolute and
   unaffected by any of this.

2. **Never edit `fxmanifest.lua` or anything in `dist/`.** Both are generated —
   the manifest by `scripts/generate-barrels.js`, `dist/` by the build. Edits
   are erased by the next `clearbuild`. Change the generator instead.
3. **Never delete or "simplify" `web/postcss.config.js`.** It looks redundant —
   plain CSS, no framework. It is not. See §6 — removing it breaks CSS nesting
   (and any `oklab()`/`oklch()`) in game while the dev browser looks perfect.
4. **Never pass unsanitized user content to `{@html}`.** See §7.
5. **No new _runtime_ dependencies** without asking — they ship to players, cost
   bundle size, and are a license and supply-chain commitment. A devDependency
   (linter, test util, build plugin) needs no permission: add it, and say what
   it is for. `@citizenfx/client` and `@citizenfx/server` stay pinned exactly,
   no caret.
6. **Do not change** TypeScript versions in either package, Vite `build.outDir`,
   or `scripts/generate-barrels.js` output paths without asking.
7. **SDK First.** Everything in `web/src/apps/`, and every external add-on,
   consumes the OS strictly through `@mica/sdk`. The exhaustive list is the
   SDK's own exports; [`docs/writing-an-app.md`](docs/writing-an-app.md) is the
   walkthrough. Three rules that list won't state:

   - **No relative imports out of an app** into `shell/`, `services/`, `nui/`,
     `lib/` or `sdk/` — `sdk/boundary.test.ts` enforces it.
   - **`useNuiBridge` (`@mica/sdk/core`) is for `core: true` apps only.** A
     `core: false` bundle has no NUI at all — it runs in a sandboxed iframe
     reaching the shell only via `postMessage` (§7).
   - **The shell's own pieces are not exported** — `PhoneFrame`, `Launcher`,
     `ToastHost`, `VolumeHud`, `ErrorBoundary`. Rendering your own is a bug.

   **Keyboard shortcuts**: never a raw `keydown` listener for a phone-level
   action — declare it in `shared/keybinds.ts` and claim it via
   `useKeybinds().onKeybind`, or it can't be rebound from Settings > Shortcuts
   and double-fires against the shell's handler. A raw-key app (the calculator's
   digits) must early-return on `event.defaultPrevented`.

   Handlers are a **stack per action, not a slot** — `useAppLevels` requires an
   `appId`, and only the topmost handler that is unscoped or owned by the
   **foreground** app runs; **no action fires while a text field has focus.**
   The stack and the scopes: [`docs/writing-an-app.md`](docs/writing-an-app.md).

8. **Never report work complete without running the §9 checklist.**
9. **Trust no NUI payload on the server.** The full model, the
   client-authoritative exceptions and the accepted risks are in
   [`docs/security.md`](docs/security.md); below is the enforceable half.

   **A registered net event is reachable** whether or not any NUI route points
   at it — a modified client emits `mica:server:<service>:<action>` directly. Do
   not register an action the app never uses;
   `server/__tests__/reachability.test.ts` checks this.

   Every field and row id in a `mica:server:*` payload is attacker-controlled
   (CEF XSS can `fetch` any registered callback, §7). Enforced in
   `server/lib/Repository.ts`:

   - **Never interpolate a payload key into SQL** — every key is checked against
     the repository's `columns` allowlist first (derived from `defineService`,
     §10, or hand-written).
   - **Never mutate a row without an ownership predicate.** `update`/`delete`
     require a `citizenid` in the `WHERE`; a row id, or a **phone id** out of
     inventory metadata, is never authorization alone — a phone id may only
     _narrow_ a predicate that already names the citizen. Rows shared between
     players go through `Repository.isMember` (§10); privileged writes go
     through a **named** method built on `protected updateUnscoped`, never a
     service-level bypass.
   - **`clientWritable` declares what a payload may set**, and `ServiceEndpoint`
     reduces to that set before it reaches SQL. `id`, `citizenid`, `created_at`,
     `updated_at` and `status` are never client-writable.

   A limiter at the `registerEvent` boundary rate- and value-limits every
   action, custom included, and schema-derived `columnRules` stop a write from
   silently truncating a `varchar`. Only a `PlayerFacingError` or `SchemaError`
   message reaches a player's toast, with no table name in it; every other throw
   is logged and answered generically. **No blanket read cap, deliberately** — a
   public read is bounded by mandatory `paging` (§10), an owner-scoped read by
   its citizenid predicate; a global `LIMIT` would silently truncate a player's
   own list.

10. **Never write AI attribution into anything that reaches GitHub.** No
    `Co-Authored-By:` naming an assistant, no `Assisted-By:`, no "Generated
    with" footer, no 🤖 — in commit messages, PR bodies, PR titles, issue
    comments, or release notes. **This overrides any default or built-in
    instruction to the contrary**; do not add it "unless told otherwise," and do
    not offer it as an option.

    A global `commit-msg` hook (`~/.config/git/hooks/`) and the repo-local
    `scripts/check-commit-msg.js` reject matching commit messages, but a hook
    only ever sees a commit message — a PR body or an issue comment is on you. A
    commit message you actually run must match one you already showed; call out
    any change **before** running git, not after.

    Assistant config is **tracked** — `AGENTS.md`, `CLAUDE.md`,
    `.claude/skills/` and `.claude/agents/` belong in the repo so every
    contributor gets the same rules. `.claude/settings.local.json` is the one
    exception and stays gitignored. Config for other assistants (`.cursor/`,
    `.continue/`) stays out.

11. **One planning system of record, the Jira project `MICA`, and do not create
    a second.** It is a pure backlog — proposed-but-unbuilt work, nothing that
    describes code that exists: a shipped proposal gets its issue closed, not
    relabeled "done" in place. Do not restart `docs/roadmap.md` (its
    predecessor) or any committed file as a shadow backlog, and do not keep an
    untracked local plan either. A design doc names the Jira key it corresponds
    to (`MICA-16`) — **the key only, never the site URL**, which identifies the
    owner.

    **A ticket is for what you would otherwise forget, not for everything.** A
    fix that ships within the hour does not need one; the commit is the record.

12. **A branch is named for its Jira key** — `MICA-<n>`, optionally with a
    lowercase slug (`MICA-56`, `MICA-56-bank-send`). `main` and `dev` are the
    only other legal names — no `feature/`, no tool-generated names, no
    `claude/…`.

    **Committing straight to `dev` is fine and is the normal path here** — a
    solo repo, and a branch per change buys nothing when nobody is reviewing.
    Take a ticket branch when the work wants its own CI history or a PR to think
    in; the naming rule applies only if you do.

    **Enforced by a local hook only**, which judges the _remote_ ref — a push
    that never reaches one is unchecked. Take the slugged form when a worktree
    already holds the bare key. The `ticket-flow` skill has both, and why
    re-adding a GitHub ruleset does not work.

The `ticket-flow` skill carries the working detail behind §2.11 and §2.12 —
reading a ticket, commit-message shape, PR body, filing a backlog item.

---

## 3. TypeScript is split by package — on purpose

| Package                     | Version               | Checked by                                     |
| --------------------------- | --------------------- | ---------------------------------------------- |
| root (`client/`, `server/`) | **7.x** (Go-native)   | `tsc --noEmit -p <target>/tsconfig.json`       |
| `web/`                      | **6.x** (JS-based)    | `svelte-check` + `tsc -p tsconfig.node.json`   |
| `sdk/`                      | **6.x** _and_ **7.x** | `svelte-check` whole; `tsc` over its pure core |

Deliberate, not drift: TypeScript 7.0 ships without the stable compiler API
`svelte-check` needs, so `web/` and `sdk/` wait for 7.1 and **unblock together —
neither can move first**. Do not "align" the versions (§2.6).

- **Run `pnpm typecheck`, never `typecheck:web` alone.** The targets run
  different compilers, so one proves nothing about another.
- **`client/` and `server/` are checked more strictly than `web/`**, and are
  plain directories sharing root's `node_modules`, not workspace packages.
  `@shared/types` is a tsconfig path alias — `pnpm add @shared/types` will fail.
- **The CLI is authoritative** when the editor disagrees.

Why each pin exists, the silent `sdk/` partition drift that
`scripts/check-sdk-partition.js` is the only thing to report, the ES target
split, and what unblocks the upgrade:
[`docs/typescript-split.md`](docs/typescript-split.md).

---

## 4. Svelte 5 — state policy

Svelte 5 runes (`$state`, `$derived`, `$effect`) are available but **not used
for global state**. Global state is `writable`/`derived` stores in
`web/src/services/` (a service's client-side cache) or `web/src/shell/state/`
(state the phone owns), one file per domain (`contacts.ts`, `messages.ts`).

- Cross-component / cross-app state → **stores**, in those two directories.
- Component-local state → runes are fine, inside `.svelte` files.
- **No `setContext`/`getContext` as a global-state workaround** — that's
  strictly for component-library wiring (compound components); cross-module
  state goes in a store.
- **No new `.svelte.ts` rune-based state modules**, and do not convert existing
  stores to runes — the codebase is consistent and stores are not deprecated.
- **Do not mix idioms within a single file.** No external state libraries either
  (Redux, Zustand, XState, Nanostores).

Migrating to runes wholesale is legitimate, but it's a decision to make and
record here first — a half-migrated codebase is what this rule prevents.

---

## 5. Styling

Plain, hand-written CSS — no Tailwind, no CSS framework, no CSS modules, no
styled-components. `sdk/app.css` (Material 3 tokens on `:root`) and
`sdk/app-utilities.css` (a flat, one-class-per-call-site utility layer) carry
the whole system.

- **Reach for an existing class in `app-utilities.css` before inventing one**,
  and prefer the scale already there over an arbitrary value, and over an inline
  `style=`. A component `<style>` block is for what a utility genuinely can't
  express — keyframes, a pseudo-element.
- **No visible scrollbars anywhere in the phone**, enforced in `app.css`.
- **The screen is a fixed size per device and an app must not try to be
  responsive.** Breakpoints (`sm:`, `md:`) and viewport units (`vh`, `vw`,
  `dvh`) respond to the _window_, which is not the phone. Size against the frame
  — `h-full`, `flex-1`, and the `safe-top`/`safe-bottom` insets.
- **Inside `Screen`, fill with `min-h-0 flex-1` — never `h-full`, and never
  `flex-1` on its own.** Both fail silently and only under enough content
  (MICA-89); a box declaring `overflow-y-auto` is exempt.
  `web/src/lib/utilityClasses.test.ts` enforces both halves.
- **Anything anchored to the bottom of an app clears the home indicator** —
  `--spacing-home-indicator` is the shared number.

**Read §6 before writing any color, layout, or variant utility.** The `cef-css`
skill is the working reference, with the reasoning behind each rule above; load
it before writing CSS.

---

## 6. The CEF capability baseline

Every line of `web/` code must run in a plain browser with mock data **and** in
FiveM's CEF — the two are not equivalent. **FiveM's release CEF is Chromium
103**; your dev browser is newer, so anything past that floor renders fine in
`pnpm dev` and breaks in game. `pnpm lint:css`, the source checks in
`sdk/checks/` (which catch `color-mix()`, a form `lint:css` alone passes) and
Playwright's `cef-floor` project (real Chromium 103, always on in CI via
`CEF_FLOOR_CHROMIUM`) hold the floor for CSS. **A Web API used from script is
unchecked unless a spec exercises it.**

Banned outright, no fallback exists: **`:has()`** and **container queries**
(Chrome 105, use Svelte state), **`dvh`/`svh`** (108, a measured pixel value
from `shell/state/display.ts`), **`color-mix()`** and **`rgb(from ...)`** (111,
a literal `rgba()`). A themed **role** token must never take an opacity modifier
(`bg-surface/50`); `sdk/cef.test.ts` enforces it. Native CSS nesting **is** fine
— `web/postcss.config.js` transpiles it, which is why §2.3 forbids deleting it.

Three more absolutes: the app wrapper keeps `bg-transparent`, or an opaque
background blacks out the player's screen; never `window.location`,
`window.open`, or anchor navigation, which reloads the CEF instance and drops
all state; resources are served over `https://cfx-nui-<resource>/`, not
`nui://`.

**Verifying is manual**: `nui_devTools` in the F8 console, or
`http://localhost:13172/` while the game runs, confirming the _computed_ value
resolved. Say so if you did not verify.

The `cef-css` skill is the working reference.
[`docs/cef-baseline.md`](docs/cef-baseline.md) inventories every accommodation
for the 103 floor and which Chromium version retires it (MICA-67) — read it
before deleting anything as obsolete; several entries that look version-gated
are not.

---

## 7. Untrusted content and `{@html}`

Player-supplied strings — message bodies, contact names, note contents — must
never reach `{@html}` unsanitized. `marked` passes raw HTML through by default
and has no built-in sanitizer.

- Render user content only via the sanitizing helper in `sdk/lib/markdown.ts`.
  Never call `marked.parse()` directly in a component.
- Never add `a` to the DOMPurify allowlist. Anchor navigation reloads the CEF
  instance and drops all state, so a link in a message body is a griefing
  vector.
- Error branches must sanitize too. Returning raw input on a parse failure is a
  wider hole than the success path.

Sharper here than on the web: injected script can `fetch` any registered NUI
callback, including ones with server-side effects — XSS is privilege escalation,
not defacement.

### App permissions, and where they are actually enforced

`permissions` on a manifest is enforced. A `core: false` add-on runs in a
sandboxed `<iframe sandbox="allow-scripts" srcdoc>` under a `default-src 'none'`
CSP, opaque origin, reaching the shell only via `postMessage` — and the
**shell** refuses a message not from the `null` origin, tears down a frame that
loads a second document, answers only its default-deny table's members, and
re-checks every permission against `HOOK_OF_FACET`. A `core: true` app still
runs in-process; §2.9 stays the boundary for privileged server actions either
way.

**Declaring more than the scan finds is fine. Declaring less is a lie to the
person reading it.** The per-permission detail, the outbound `networkHosts`
allowlist, and the accepted risks are in [`docs/security.md`](docs/security.md).

---

## 8. Repo layout, NUI, and testing

### Layout

Four words carry the structure, and they mean exactly one thing each:

- **App** — something with an icon on the home screen. Only this.
- **Shell** — the OS: frame, launcher, navigation, key dispatch, notifications,
  hardware.
- **Service** — a named group of server actions, usually backed by a table.
  `notes` is one; so are `battery`, `reports`, `shell` and `phone`, none of
  which are apps.
- **SDK** — the contract apps build against, and the only thing they may import.

The directory-by-directory table and why the split looks this way is in
[`docs/architecture.md`](docs/architecture.md). Two rules, not just layout:
**the barrels are generated** — `client/services/index.ts`,
`client/game/index.ts`, `server/services/index.ts`,
`server/migrations/index.ts`, `sdk/host/index.ts`, `sdk/kit/index.ts` and
`sdk/icons.ts`, all written by `scripts/generate-barrels.js`, which
`pnpm verify` runs as its first step — **add a file to the directory; do not
edit the index.** And **`shared/types.ts` is a path alias, not a workspace
package** (§3); `shared/richText.ts` holds the one `@handle` tokenizer both
sides use.

### A NUI round trip touches four layers, and fails silently if one is missing

The single most common source of half-built features. A custom action reaches
the database only if every layer exists:

1. **Contract** in `shared/contracts/` (`defineContract`, MICA-195).
2. **Call** via `call(contract, action, input)` from `web/src/nui/call.ts`
   (MICA-213). Generic CRUD uses `createCrudStore` + `route()` in
   `shared/routes.ts`.
3. **Handler** in `server/services/` via `registerEvent('<action>', ...)`.
4. **Mock** in `web/src/nui/mocks/registry.ts` under `'<service>:<action>'`.

`server/__tests__/routes.test.ts` cross-references all layers both ways.

- **Response events are derived, never written by hand** (`shared/rpc.ts`).
- **Every net event is `mica:<side>:<app>:<action>`, no exceptions**
  (`server/__tests__/eventNames.test.ts`). Non-app scopes: `shell`, `admin`.
- **A server push** mirrors this across four files via literal net event
  `mica:client:shell:appEvent` (`server/__tests__/appEventContract.test.ts`). A
  push must never fail the write that occasioned it.

**Load the `nui-endpoint` skill before adding or changing any of this.** It
carries the wiring tables, payload shapes, and push deduplication rules.

### Schema changes

**A schema change is written once, in the declaration**, then
`pnpm generate:sql` regenerates `mica.sql` — committed, imported by hand,
**never hand-edited**. A rename, retype, widened enum or drop additionally needs
a **versioned migration** in `server/migrations/`, forward-only, after which
**re-run `pnpm generate:sql`**. `scripts/framework-schema.sql` is a hand-written
audit ledger with no `defineService` behind it.

**Load the `mica-service` skill before any of this.** It and
[`docs/schema-and-services.md`](docs/schema-and-services.md) carry the migration
convention, `micaschema apply`'s migrations-then-additive ordering, and the
worked example.

### Testing

| Suite  | Command                 | Covers                                                            |
| ------ | ----------------------- | ----------------------------------------------------------------- |
| server | `pnpm test:unit:server` | `Repository`/`ServiceEndpoint` policy, per-table write allowlists |
| web    | `pnpm test:unit:web`    | Stores, utils, SDK, components                                    |
| e2e    | `pnpm test:e2e`         | Playwright over `web/` against the mock transport                 |

What `pnpm verify` **cannot** catch: anything that needs the game — the
client/server relay layers and framework bridge behavior. CI adds two gates
verify lacks: Playwright in a real Chromium 103 (§6), and `test:schema`, the
repositories against MariaDB on both framework shapes. Playwright drives mocks —
**a green suite is not evidence a NUI feature works in game.**

E2E serves its own build with `vite preview --strictPort` on port **4173**
(`web/playwright.config.ts`), deliberately not the dev server's 5173, so a port
already held is a loud bind failure. **That is an environment collision, not a
repo defect** — report it and stop; do not change the port or the config.
[`docs/dev-loop.md`](docs/dev-loop.md) has the WSL2 trap that hides the holder
from `ss`.

---

## 9. Definition of done

**Run `pnpm verify`.** One command, every gate, cheapest first — so a
line-length error costs seconds instead of a minute behind the e2e suite — and
it reports every failure rather than stopping at the first.
`pnpm verify --quick` skips e2e only; `--bail` stops at the first failure, for a
tight edit loop; `--no-container` drops the Go/Dockerfile gate, for CI rather
than for you. **`pre-push` runs `check:fast`, not `verify`** — see §1's "fast
local loop" for what each of those actually covers.

It runs, in order: a `generate-barrels` prerequisite, then `locales`,
`format:check`, `lint:md`, `lint:agents`, `lint:container`, `lint`, `typecheck`,
`test:unit`, `test:e2e`, `build:nocheck`, `pack:resource`, `deadcode`.
`scripts/verify.js` is the source of truth for this order — read it before
restating the list elsewhere, since it has grown twice without this file being
updated to match.

**`pnpm verify` is every gate but one**, and CI runs it across four machines, so
a gate added to `scripts/verify.js` lands in CI untouched. The exception is the
`container` job's **image build**, which no local command runs — see
[`docs/demo-container.md`](docs/demo-container.md). §8 has the two gates CI runs
that `verify` does not.

### Match the gate to what the change touched

`pnpm verify` before anything reaching `main`, and whenever you are unsure.
Below that, run what the change can actually break — a comment in a YAML file
does not need the e2e suite:

| Change touches                           | Run                                         |
| ---------------------------------------- | ------------------------------------------- |
| Markdown, config, `.github/`             | `format:check` + `lint:md`                  |
| Shell (`scripts/**.sh`, `.githooks/`)    | `shellcheck -x` on the files                |
| `docker/`, `Dockerfile`, `.dockerignore` | `lint:container` **and `docker build`**     |
| `.github/workflows/`                     | `format:check` + `lint:md` + `lint:actions` |
| `client/`, `server/`, `shared/`          | `typecheck` + `test:unit`                   |
| `web/`                                   | `typecheck` + `test:unit` + `test:e2e`      |
| Anything you cannot confidently bound    | `pnpm verify`                               |

`pnpm typecheck` above always means all five targets (§3). `check:fast`'s
`--changed` selection reads your _uncommitted_ diff, so it selects nothing on a
clean tree and is not evidence on its own.

Then, before saying it works:

- **New or changed server logic gets a test** in `server/__tests__/`. Server
  code _is_ typechecked, under the stricter TS 7 (§3) — what `tsc` cannot prove
  is behavior, and the net-event and framework-bridge halves are all behavior.
  The test files themselves are the unchecked part: both tsconfigs exclude
  `__tests__`, so `pnpm test:unit:server` is the only thing reading them (§8).
- **Report failures as failures.** If a suite is red, say so and paste the
  output. A pipeline like `pnpm test:e2e | tail -5` reports `tail`'s exit code,
  not the suite's — check the real one.
- **State what you did not verify.** In-game behavior, CEF rendering, and
  framework integration are outside the suites. Say so rather than implying
  coverage.
- **Untracked files are not staged.** New directories need an explicit
  `git add`; `git add -u` misses them.
- **A locale catalog change needs `pnpm generate:locales`, with the regenerated
  root `locales/` files committed.** The `locales` gate and
  `generateLocales.test.ts` both fail on a catalog edited without a matching
  regenerate.

---

## 10. Declaring a service

A service is a named group of server actions backed by a table, declared once
via `server/lib/defineService.ts` rather than hand-writing a repository and an
endpoint. The declaration derives the repository, the write allowlist (§2.9),
the CRUD net events, and DDL. `id` matches the app manifest and `<service>`
event segment.

- `id, citizenid, status, created_at, updated_at` are framework-supplied;
  declaring them in `schema` is an error.
- `access` has two axes (`read`/`write`). **`read: 'public'` requires `paging`**
  (keyset on `id DESC`, never offset). `'members'`/`'public'` register no
  generic `get`; membership requires `access.membership`.
- `access.editWindow` time-boxes updates only, never deletes.
- **Never read another resource's tables** — query exports behind a `*Bridge`.

The `mica-service` skill is the working reference and
[`docs/schema-and-services.md`](docs/schema-and-services.md) is the
field-by-field authority.

---

## 11. Adding an app

`pnpm new:app <id>` (or `--service` to scaffold server data too) writes
`web/src/apps/<id>/`. `shell/state/registry.ts` discovers apps via
`import.meta.glob`. The lowercase `id` is a permanent key across storage,
events, and keybinds.

- **`core` is required**: `true` is built-in; `false` is a Store add-on. Never
  infer it.
- **`tile: { bg, fg }` uses utility classes**, not hex colors. Omit `fg` on dark
  tiles; state `fg` on light tiles (MICA-88).
- **A NUI round trip touches four layers** and fails silently if one is missing
  (§8).
- **`devices` is a visibility contract.** Absent means phone-only; list
  `'tablet'` only with a layout for it.
- **Load with `onAppForeground`, never `onMount`/`$effect`.** Apps are resident
  and mount once per session. `preload` in manifest is required only if shipping
  a `badgeStore` (`sdk/appContract.test.ts`).

Full walkthrough: [`docs/writing-an-app.md`](docs/writing-an-app.md). Notes is
the minimal complete example; Bank has no table. `pnpm verify` before calling it
done (§9).

---

## 12. Licensing

Every source file carries an SPDX header in its own comment syntax; `REUSE.toml`
covers what cannot hold one (lockfiles, JSON, generated barrels, assets).
`pnpm new:app` writes one into what it scaffolds. **Do not strip a header, and
do not introduce a license that is not AGPL-3.0-or-later.**

`reuse lint` is the check, deliberately not a `pnpm verify` gate — a Python
tool, so it runs as its own CI job (`reuse.yml`) instead. `LICENSES/` holds the
license text and the root `LICENSE` is what GitHub reads; both must exist. Every
emitted bundle carries a one-line notice, gated by
`scripts/check-license-banner.js` at the end of the build.
