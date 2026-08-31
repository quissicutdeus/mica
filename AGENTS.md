# AGENTS.md

**gphone** — an open-source TypeScript phone for FiveM. AGPL-3.0-or-later.

pnpm workspace, three build targets:

| Target      | Source    | Built by                            | Runtime                              |
| ----------- | --------- | ----------------------------------- | ------------------------------------ |
| Game client | `client/` | esbuild via `build/build-bundle.js` | FiveM client                         |
| Game server | `server/` | esbuild via `build/build-bundle.js` | FiveM server                         |
| UI          | `web/`    | Vite                                | CEF **and** a plain browser — see §6 |

Node 26 · Svelte **5** · Vite 8 · Vitest 4 · Playwright 1.x TypeScript is
**split by package** — see §3. Exact versions: `pnpm list`. `@citizenfx/client`
and `@citizenfx/server` are **pinned exactly, no caret** — leave them that way.

**This file is what is true for every task.** Detail that is true only for one
kind of work lives in a skill (`.claude/skills/`, listed in `CLAUDE.md`) or a
doc, and each section below points at the one that holds it. A pointer means the
rule is still in force and its detail is one file away — never that it stopped
applying. **This file is capped at 40,000 characters** and `pnpm lint:agents` (a
`pnpm verify` gate) fails above it, warning first — so new detail goes to a
skill or a doc, with a pointer left here, rather than growing this file.

---

## 1. Commands

`pnpm` only. Never `npm`, `npx`, `bun`, or `yarn`. Use `pnpm dlx` where you
would reach for `npx`.

Run from the **repo root** unless noted.

| Task                                              | Command                                      | Pre-approved?            |
| ------------------------------------------------- | -------------------------------------------- | ------------------------ |
| **Every gate, in order**                          | **`pnpm verify`**                            | Yes                      |
| Every gate except e2e                             | `pnpm verify --quick`                        | Yes                      |
| Fast loop: format + typecheck + changed unit only | `pnpm check:fast`                            | Yes                      |
| Fail fast if no dev server is warm                | `pnpm dev:check`                             | Yes                      |
| Lint the Go server and the Dockerfile             | `pnpm lint:container`                        | Yes                      |
| Check workflow actions for a newer major          | `pnpm lint:actions`                          | Yes                      |
| Run the demo image locally                        | `pnpm demo` / `demo:up` / `demo:down`        | Yes                      |
| Smoke-test a running demo image                   | `pnpm demo:smoke`                            | Yes                      |
| Scaffold an app                                   | `pnpm new:app <id> [--service]`              | Yes                      |
| Install                                           | `pnpm install --frozen-lockfile`             | Yes                      |
| Format (write)                                    | `pnpm format`                                | Yes                      |
| Format (check)                                    | `pnpm format:check`                          | Yes                      |
| Dead code scan                                    | `pnpm deadcode`                              | Yes                      |
| Typecheck **everything**                          | `pnpm typecheck`                             | Yes                      |
| Typecheck one target                              | `pnpm typecheck:client` · `:server` · `:web` | Yes                      |
| Unit tests **everything**                         | `pnpm test:unit`                             | Yes                      |
| Unit tests one project                            | `pnpm test:unit:web` · `:server`             | Yes                      |
| E2E tests                                         | `pnpm test:e2e`                              | Yes                      |
| Install browsers (first run)                      | `pnpm test:e2e:install`                      | Yes                      |
| Generate per-app SQL                              | `pnpm generate:sql`                          | Yes                      |
| Generate + dev reset SQL                          | `pnpm generate:sql:reset`                    | Ask first — destructive  |
| Full build                                        | `pnpm build`                                 | Yes                      |
| Dev (both watchers)                               | `pnpm dev`                                   | Ask first — long-running |
| Commit / push on `dev` or a ticket branch         | —                                            | Yes — see §2.1           |
| Force-push, move `main`, change protection        | —                                            | **Ask first. See §2.1.** |

`pnpm typecheck` fans out to all three targets via `concurrently`. **Use it, not
`pnpm typecheck:web`** — the targets run _different TypeScript versions_ (§3),
so a web-only check proves nothing about `client/` or `server/`.

Commands the **user** runs, not you — suggest, don't invoke:

- `pnpm test:e2e:report` — HTML report
- `pnpm test:e2e:headed` — live visual run, single worker

**Formatting**: Prettier is configured root-wide with `prettier-plugin-svelte`.
Run `pnpm format` to format code across the workspace.

### In-game commands

`gphoneschema`, `gphonemedia`, `gphonecharge`, `gphoneseed` and `gphonecall`,
all admin-gated by `isAdmin` in `server/services/Admin.ts` — the
`gphone_admin_aces` convar, defaulting to `gphone.admin` and `command`. The
server console (`source` 0) is trusted. **Two subcommands are gated harder and
take the console and nobody else**: `gphoneschema apply`, which changes a live
schema (§8), and `gphonemedia prune`, which deletes rows. Each command, its
arguments, and its dry run:
[`docs/in-game-commands.md`](docs/in-game-commands.md).

### The two Vitest projects

`pnpm test:unit` fans out to **two separate Vitest projects**, and they are not
interchangeable. `web/src/**/*.test.ts` runs under `web/vite.config.ts`;
`server/__tests__/` and `client/__tests__/` run under the root
`vitest.config.ts`, in a node environment with no plugins and no globals, so
imports are explicit.

Server tests live in `server/__tests__/` because both tsconfigs exclude that
directory, so `pnpm typecheck` stays a check of shipping code only. The
trade-off is that **server tests are not typechecked**; `pnpm test:unit:server`
is what validates them.

`server/__tests__/setup.ts` stubs the FiveM globals (`exports`, `onNet`,
`emitNet`, `source`) — server modules touch these at import time, so a suite
that forgets it fails on import, not on assertion. **Mock `../lib/Database` in
any suite that loads a repository**: `Database` reads `exports.oxmysql` in
module scope and must never reach a real connection from a test.

### The fast local loop

`pnpm verify` is the gate (§9), not the thing to run after every edit — a cold
run costs minutes. `pnpm check:fast` is the named middle ground and what the
pre-push hook runs; `pnpm verify:quick` is the CI-grade check before opening a
PR. `pnpm dev` is worth keeping running for manually driving the phone in a
browser, but e2e no longer needs it warm, so `pnpm dev:check` is a courtesy for
that workflow rather than a prerequisite.

[`docs/dev-loop.md`](docs/dev-loop.md) has the per-file commands, the
`--changed` caveat that makes `check:fast` run the whole suite while
`package.json` is in your diff, Playwright's timeout and its
`test.setTimeout(N)` escape hatch, why `pnpm test:unit` costs what it costs, and
how to prune `.claude/worktrees/`.

---

## 2. Hard constraints

Not negotiable. If a task appears to require breaking one, **stop and ask** — do
not work around it.

1. **Git: commit and push freely on `dev`.** `add`, `commit`, `push`,
   `checkout`, `branch` and `stash` on `dev` or a ticket branch need no
   permission. This is a solo project; asking per-command bought nothing and
   cost a whole session in round-trips.

   **Stop and ask** before any of these, which are hard to undo or reach further
   than the working tree: a force-push (`--force`, `--force-with-lease`) or any
   rewrite of already-pushed history; `reset --hard` over uncommitted work;
   anything that moves `main`; changing branch protection or repository
   settings; `--no-verify`. Say what you are about to do and why, then wait.

   §2.10 is unaffected — the attribution ban is absolute, and nothing here
   loosens it.

2. **Never edit `fxmanifest.lua` or anything in `dist/`.** Both are generated —
   the manifest by `scripts/generate-barrels.js`, `dist/` by the build. Edits
   are erased by the next `clearbuild`. Change the generator instead.
3. **Never delete or "simplify" `web/postcss.config.js`.** It looks redundant —
   plain CSS, no framework. It is not. See §6 — removing it breaks CSS nesting
   (and any `oklab()`/`oklch()`) in game while the dev browser looks perfect.
4. **Never pass unsanitized user content to `{@html}`.** See §7.
5. **No new _runtime_ dependencies** without asking — they ship to players, cost
   bundle size, and are a licence and supply-chain commitment. A devDependency
   (linter, test util, build plugin) needs no permission: add it, and say what
   it is for. `@citizenfx/client` and `@citizenfx/server` stay pinned exactly,
   no caret.
6. **Do not change** TypeScript versions in either package, Vite `build.outDir`,
   or `scripts/generate-barrels.js` output paths without asking.
7. **SDK First.** Everything in `web/src/apps/`, and every external add-on,
   consumes the OS strictly through `@gphone/sdk` — the data and OS-service
   hooks, the UI primitives in `web/src/sdk/ui/`, and the four an app is built
   out of: `useAppLevels`, `useAppAction`, `useDeepLink`, `onAppForeground`. The
   exhaustive list is the SDK's own exports;
   [`docs/writing-an-app.md`](docs/writing-an-app.md) is the walkthrough. Three
   things that list will not tell you:

   - **Relative imports out of an app are prohibited** — into `shell/`,
     `services/`, `nui/`, `lib/` or `sdk/` by path.
     `web/src/sdk/boundary.test.ts` enforces it.
   - **`useNuiBridge` is on `@gphone/sdk/core`, and only a `core: true` app may
     import it.** It is the raw transport, and `boundary.test.ts` refuses it to
     add-ons. A `core: false` bundle has no NUI at all: it runs in a sandboxed
     iframe whose only route to the shell is `postMessage` (§7).
   - **The shell's own pieces are deliberately not exported** — `PhoneFrame`,
     `Launcher`, `ToastHost`, `VolumeHud`, `ErrorBoundary`. An app rendering its
     own phone frame or toast host is a bug.

   **Keyboard shortcuts.** Never add a raw `keydown` listener or
   `<svelte:window on:keydown>` for a phone-level action; declare it in
   `shared/keybinds.ts` and claim it with `useKeybinds().onKeybind`. An app that
   listens directly cannot be rebound from Settings > Shortcuts and will
   double-fire against the shell's own handler. An app that needs raw keys (the
   calculator's digits) must early-return on `event.defaultPrevented`.

   Handlers are a **stack per action, not a slot**, `useAppLevels` requires an
   `appId`, and the dispatcher runs only the topmost handler that is unscoped or
   owned by the **foreground** app. Shell handlers pass no id and are the
   fallback. `scope: 'game'` actions rebind in FiveM's Key Bindings menu;
   `scope: 'phone'` actions rebind in gPhone's Shortcuts screen. **Both must
   refuse to fire while a text field has focus.** Why a stack rather than a
   slot, and why residency forces the `appId`:
   [`docs/writing-an-app.md`](docs/writing-an-app.md).

8. **Never report work complete without running the §9 checklist.**
9. **Trust no NUI payload on the server.** The full model — every entry point,
   what is deliberately client-authoritative and why, and the accepted risks —
   is [`docs/security.md`](docs/security.md). The rules below are the
   enforceable half.

   **A registered net event is reachable**, regardless of whether any NUI route
   points at it — a modified client emits `gphone:server:<service>:<action>`
   directly. Do not register a generic action the app does not use —
   `server/__tests__/reachability.test.ts` keeps that honest.

   Every field and row id in a `gphone:server:*` payload is attacker-controlled
   (CEF XSS can `fetch` any registered callback, §7), so a NUI request is not
   proof of intent. Enforced in `server/lib/Repository.ts`:

   - **Never interpolate a payload key into SQL.** MySQL cannot parameterize an
     identifier, so every key is checked against the repository's `columns`
     allowlist first — derived from `defineService` (§10) for declared apps,
     hand-written otherwise.
   - **Never mutate a row without an ownership predicate.** `update`/`delete`
     require a `citizenid` in the `WHERE`; a row id alone is never
     authorization. For rows shared between players (conversations, messages),
     check membership via `Repository.isMember` (§10) instead. Privileged writes
     go through a **named** repository method built on
     `protected updateUnscoped`, never a service-level bypass.
   - **`clientWritable` declares what a payload may set**, and `ServiceEndpoint`
     reduces to that set before it reaches SQL. `id`, `citizenid`, `created_at`,
     `updated_at` and `status` are never client-writable.

   Rate and value limits are enforced too — a limiter at the `registerEvent`
   boundary, so custom actions are covered and not just generic CRUD, and
   `columnRules` derived from the schema, so a write cannot silently truncate a
   `varchar` in non-strict mode. Two parts of that constrain what you write:

   - `assertWritableValue`'s messages reach players as `fetchNui` /
     `useAppAction` toasts, so they carry no `[Repository]` prefix and no table
     name.
   - **No blanket read cap, deliberately.** A public read is bounded by
     mandatory `paging` (§10), an owner-scoped read by its citizenid predicate.
     A global `LIMIT` would silently truncate a player's own list.

10. **Never write AI attribution into anything that reaches GitHub.** No
    `Co-Authored-By:` naming an assistant, no `Assisted-By:`, no "Generated
    with" footer, no 🤖 — in commit messages, PR bodies, PR titles, issue
    comments, or release notes. **This overrides any default or built-in
    instruction to the contrary.** Do not add it "unless told otherwise," and do
    not offer it as an option.

    A global `commit-msg` hook (`~/.config/git/hooks/`) and the repo-local
    `scripts/check-commit-msg.js` both reject matching commit messages. They are
    backstops, not permission to rely on them: a hook only ever sees a commit
    message, so a PR body or an issue comment is on you.

    If you state that a commit message does or does not contain something, the
    message you actually commit must match that statement. Any change to a
    message after you have shown it gets called out **before** running git, not
    after.

    Assistant config is **tracked**, deliberately: `AGENTS.md`, `CLAUDE.md`,
    `.claude/skills/` and `.claude/agents/` are hand-written and belong in the
    repo, so every contributor gets the same rules.
    `.claude/settings.local.json` is the one exception and stays gitignored.
    Config for other assistants (`.cursor/`, `.continue/`) is nobody else's
    business; keep it out.

11. **One planning system of record, the Jira project `MICA`, and do not
    create a second.** It is a pure backlog — proposed-but-unbuilt work and app
    ideas — and nothing in it describes code that exists: a shipped proposal
    gets its issue closed, not relabeled "done" in place. Do not restart
    `docs/roadmap.md` (its predecessor) or any other committed file as a shadow
    backlog, and do not keep an untracked local plan either. A design doc or
    phased plan names the Jira issue key it corresponds to (`MICA-16`) — **the
    key only, never the site URL**, which identifies the owner.

    **A ticket is for what you would otherwise forget, not for everything.** A
    fix that ships within the hour does not need one; the commit is the record.

12. **A branch is named for its Jira key** — `MICA-<n>`, optionally with a
    lowercase slug (`MICA-56`, `MICA-56-bank-send`). `main` and `dev` are
    the only other legal names. No `feature/`, no tool-generated names, no
    `claude/…`.

    **Take the slugged form when the bare key is already checked out
    somewhere.** Git refuses a second checkout of one branch, so a stale
    worktree holding `MICA-136` makes the plain key unavailable — that is
    ordinary, not an error to route around, and `MICA-136-player-loaded` is
    equally legal. `git worktree list` shows what is holding it; see the pruning
    procedure in [`docs/dev-loop.md`](docs/dev-loop.md) before removing any.

    **Committing straight to `dev` is fine, and is the normal path here.** This
    is a solo repo; a branch per change buys nothing when nobody is reviewing.
    Take a ticket branch when the work is long enough to want its own CI
    history, or when you want a PR to think in — neither is required, and the
    rule above governs the name only if you make one.

    **Enforced in one place, and it is a local hook.** `scripts/pre-push.js`
    judges names via `scripts/check-branch-name.js` and then runs `check:fast`.
    It judges the _remote_ ref of each push, so
    `git push origin HEAD:refs/heads/MICA-56` is legal from a
    differently-named local branch. Deletions are exempt, and a delete-only push
    skips `check:fast`.

    **A push that never reaches a local hook is not checked at all** — the web
    UI, or anything pushed by an app. Nothing covers those: GitHub refuses a
    `branch_name_pattern` ruleset on this repository (`422 Invalid rule`), so do
    not re-add one without confirming the API accepts it first.

The `ticket-flow` skill carries the working detail behind §2.11 and §2.12 —
reading a ticket, commit-message shape, PR body, filing a backlog item.

---

## 3. TypeScript is split by package — on purpose

| Package                     | Version             | Checked by                                   |
| --------------------------- | ------------------- | -------------------------------------------- |
| root (`client/`, `server/`) | **7.x** (Go-native) | `tsc --noEmit -p <target>/tsconfig.json`     |
| `web/`                      | **6.x** (JS-based)  | `svelte-check` + `tsc -p tsconfig.node.json` |

Deliberate, not drift. TypeScript 7.0 ships without a stable programmatic
compiler API, and `svelte-check` (via `svelte2tsx`) requires it; that API lands
in 7.1. `client/` and `server/` are plain `tsc` with no Svelte involvement, so
they get the native compiler now and `web/` waits.

- **Do not "align" the versions.** Bumping `web/` to 7 breaks
  `pnpm typecheck:web`. Dropping root to 6 discards the reason the split exists.
- **`client/` and `server/` are checked more strictly than `web/`.** TS 7 makes
  `strict` and the 6.0 deprecations hard defaults. Code that passes in `web/`
  may fail in `client/`.
- **`@shared/types` is a tsconfig path alias, not a workspace package.** It
  appears in no `dependencies` block and `pnpm add @shared/types` will fail. TS
  7 removed `baseUrl`, so path mappings in `client/` and `server/` must be
  relative to their own tsconfig.
- **`client/` and `server/` are plain directories**, not workspace packages —
  they share root's `node_modules`. Only `web/` is a separate pnpm project.
- **Editor errors may disagree with CLI errors** in `web/`, because the language
  service picks one TypeScript for the whole workspace. **The CLI is
  authoritative.** If `pnpm typecheck` is clean, the code is clean regardless of
  editor squiggles. The usual case is a stale cache after a type changed —
  adding a field to an interface and getting
  `ts(2353) 'x' does not exist in type` at a call site that plainly has it. Run
  **Svelte: Restart Language Server** for a `.svelte` file, or **TypeScript:
  Restart TS Server** for a `.ts` one, before believing it.
- When 7.1 ships, the migration is: bump `svelte-check`, bump `web/` to 7,
  delete this section.

---

## 4. Svelte 5 — state policy

Svelte 5 is installed, so runes (`$state`, `$derived`, `$effect`) are available.
**This repo does not use them for global state.** Global state is `writable` /
`derived` stores in `web/src/services/` (a service's client-side cache) or
`web/src/shell/state/` (state the phone itself owns), one file per domain
(`contacts.ts`, `messages.ts`).

- Cross-component / cross-app state → **stores**, in `web/src/services/` or
  `web/src/shell/state/`.
- Component-local state → runes are fine, inside `.svelte` files.
- **Do not use `setContext`/`getContext` as a workaround for global state.** If
  state needs to be accessed across disparate modules, put it in a store.
  Context is strictly for component library wiring (e.g., compound components).
- **Do not** introduce `.svelte.ts` rune-based state modules, and do not convert
  existing stores to runes. Stores are not deprecated in Svelte 5 and the
  codebase is currently consistent.
- **Do not mix idioms within a single file.**

No external state libraries — no Redux, Zustand, XState, Nanostores.

> Migrating to runes wholesale is legitimate, but it is a decision to make and
> record here first. A half-migrated codebase is the failure mode this rule
> exists to prevent.

---

## 5. Styling

Plain, hand-written CSS — no Tailwind, no CSS framework, no CSS modules, no
styled-components. Two files carry the whole system: `web/src/app.css` (Material
3 design tokens on `:root`) and `web/src/app-utilities.css` (a flat,
hand-authored utility layer, one class per call site, each resolving to a
token).

- **Reach for an existing class in `app-utilities.css` before inventing one**,
  and prefer the scale already there over an arbitrary value. Add a class rather
  than an inline `style=`. A component `<style>` block is for what a utility
  genuinely can't express — keyframes, a pseudo-element.
- **No visible scrollbars anywhere in the phone**, enforced in `app.css`.
- **The screen is always 400x850 and an app must not try to be responsive.**
  Breakpoints (`sm:`, `md:`) and viewport units (`vh`, `vw`, `dvh`) respond to
  the _window_, which is not the phone. Size against the frame — `h-full`,
  `flex-1`, and the `safe-top`/`safe-bottom` insets.
- **Inside `Screen`, fill with `min-h-0 flex-1` — never `h-full`, and never
  `flex-1` on its own.** Both fail silently and only under enough content
  (MICA-89); a box declaring `overflow-y-auto` is exempt.
  `web/src/lib/utilityClasses.test.ts` enforces both halves.
- **Anything anchored to the bottom of an app clears the home indicator** —
  `--spacing-home-indicator` is the shared number.

**Read §6 before writing any colour, layout, or variant utility.** The `cef-css`
skill is the working reference, with the reasoning behind each rule above; load
it before writing CSS.

---

## 6. The CEF capability baseline

Every line of `web/` code must run in a plain browser with mock data **and** in
FiveM's CEF, and the two are not equivalent.

**FiveM's release CEF is Chromium 103.** Your dev browser is current, so
anything newer renders correctly in `pnpm dev`, passes Playwright, and is broken
in-game. **Nothing in the automated suite catches this class of bug.** A CEF
upgrade (M140/M144) is in progress upstream but not in the release client; until
it ships, assume 103.

Banned outright, because no fallback exists: **`:has()`** (Chrome 105),
**container queries** (105), **`dvh`/`svh`** (108), **`color-mix()`** (111) —
use Svelte state for the first two, a measured pixel value from
`shell/state/display.ts` for the third, a literal `rgba()` for the fourth. A
themed **role** token must never take an opacity modifier (`bg-surface/50`);
`sdk/cef.test.ts` enforces that. Native CSS nesting **is** fine —
`web/postcss.config.js` transpiles it, which is why §2.3 forbids deleting it.

Three more absolutes: the app wrapper keeps `bg-transparent`, or an opaque
background blacks out the player's screen; never `window.location`,
`window.open`, or anchor navigation, which reloads the CEF instance and drops
all state; resources are served over `https://cfx-nui-<resource>/`, not
`nui://`.

**Verifying is manual**: `nui_devTools` in the F8 console, or
`http://localhost:13172/` while the game runs. Confirm the _computed_ value
resolved, not just that the declaration is present. If you did not do this, say
the change is unverified in CEF.

The `cef-css` skill is the working reference. Every accommodation this repo
makes for the 103 floor — and which Chromium version retires it — is inventoried
in [`docs/cef-baseline.md`](docs/cef-baseline.md), the MICA-67 watch item.
Read it before deleting anything as obsolete; several entries that look
version-gated are not.

---

## 7. Untrusted content and `{@html}`

Player-supplied strings — message bodies, contact names, note contents — must
never reach `{@html}` unsanitized. `marked` passes raw HTML through by default
and has no built-in sanitizer.

- Render user content only via the sanitizing helper in
  `web/src/lib/sdk/markdown.ts`. Never call `marked.parse()` directly in a
  component.
- Never add `a` to the DOMPurify allowlist. Anchor navigation reloads the CEF
  instance and drops all state, so a link in a message body is a griefing
  vector.
- Error branches must sanitize too. Returning raw input on a parse failure is a
  wider hole than the success path.

Why this is sharper in CEF than on the web: injected script can `fetch` against
`https://<resource>/<event>` and invoke any registered NUI callback, including
ones with server-side effects. XSS here is privilege escalation, not just
defacement.

### App permissions, and where they are actually enforced

`permissions` on a manifest is enforced. A `core: false` add-on runs in a
sandboxed `<iframe sandbox="allow-scripts" srcdoc>` with an opaque origin and no
route to the shell but `postMessage`, and the **shell** re-checks every
permission against `HOOK_OF_FACET` in `web/src/sdk/permissions.ts` before
answering a call — the frame's own check is a courtesy, not the boundary. A
`core: true` app still runs in-process. §2.9 stays the boundary for privileged
server actions either way.

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

The directory-by-directory table, and why the split looks this way —
`client/services/` vs. `client/game/`, why `services/` names repeat across
client and server, why stores live outside `apps/`, the `server/lib/` casing
convention — is in [`docs/architecture.md`](docs/architecture.md).

Two things about it are rules rather than layout, so they live here. **The
barrels are generated** — `client/services/index.ts`, `client/game/index.ts`,
`server/services/index.ts`, `server/migrations/index.ts`,
`web/src/sdk/host/index.ts`, `web/src/sdk/kit/index.ts` and
`web/src/sdk/icons.ts`, all written by `scripts/generate-barrels.js`, which
`pnpm verify` runs as its first step: **add a file to the directory; do not edit
the index.** And **`shared/types.ts` is a path alias, not a workspace package**
(§3), while `shared/richText.ts` holds the one `@handle` tokenizer the UI
renders from and the server notifies from.

### A NUI round trip touches three files, and fails silently if one is missing

The single most common source of half-built features. A call from `web/` reaches
the database only if every layer exists: **`fetchNui`** in `web/src/services/`,
a **`route()` entry** in `shared/routes.ts` (core apps only — an add-on goes
through the generic `useService(id).call(...)`), and a **`registerEvent`**
handler or generic CRUD action in `server/services/`. Miss the middle one and
the NUI callback is never registered: `fetchNui` swallows the failure and
returns its `defaultValue`, so **the feature does nothing in game** while
passing every suite.

**Mocks make a missing layer invisible.** `web/src/nui/mocks/registry.ts`
answers by action name, so add all three layers _and_ the mock. When touching an
existing endpoint, grep `client/` and `server/` for the action name before
assuming it is wired. `server/__tests__/routes.test.ts` cross-references all
four.

**Response events are derived, never written by hand** — `shared/rpc.ts` owns
them, and a hand-written reply name times out after 15s with no error.

**Every net event is `gphone:<side>:<app>:<action>`, with no exceptions**, and
`server/__tests__/eventNames.test.ts` fails on anything else — including an
`<app>` segment that is neither a declared app nor one of the two non-app
scopes, **`shell`** and **`admin`**. NUI _message_ actions (`setVisible`,
`receiveMail`) are a **separate namespace** with no `gphone:` prefix.

A **server push** mirrors this across four files and fails just as silently;
`server/__tests__/appEventContract.test.ts` catches that. It is one literal net
event, `gphone:client:shell:appEvent`, dispatched by app id from the envelope.
**A push must never be allowed to fail the write that occasioned it**, and
`onAppForeground` (§11) is still required — a push does not excuse it.

**Load the `nui-endpoint` skill before adding or changing any of this.** It
carries the full tables, the payload-shape rules, where to subscribe and why
residency makes that a correctness question, and `pushMany`'s
deduplicate-by-owner rule.

### Schema changes

**A schema change is written once, in the declaration**, then
`pnpm generate:sql` regenerates `gphone.sql` — committed, imported by hand,
**never hand-edited**. A rename, retype, widened enum or drop additionally needs
a **versioned migration** in `server/migrations/`, forward-only, after which
**re-run `pnpm generate:sql`**. `scripts/framework-schema.sql` is the
hand-written audit ledger and has no `defineService` behind it.

**Load the `gphone-service` skill before any of this.** It and
[`docs/schema-and-services.md`](docs/schema-and-services.md) carry the migration
file convention, `gphoneschema apply`'s migrations-then-additive ordering (a
correctness requirement, not a preference), and the worked example.

### Testing

| Suite  | Command                 | Covers                                                            |
| ------ | ----------------------- | ----------------------------------------------------------------- |
| server | `pnpm test:unit:server` | `Repository`/`ServiceEndpoint` policy, per-table write allowlists |
| web    | `pnpm test:unit:web`    | Stores, utils, SDK, components                                    |
| e2e    | `pnpm test:e2e`         | Playwright over `web/` against the mock transport                 |

What the suites **cannot** catch: anything that needs the game. The Chromium-103
gap (§6), the client/server relay layers above, framework bridge behavior, and
SQL that only fails against a real schema. Playwright drives a modern Chromium
against mocks — **a green suite is not evidence a NUI feature works in game.**

E2E note: `webServer` builds a bundle and serves it with
`vite preview --strictPort` on port 4173 (`web/playwright.config.ts`),
deliberately not the dev server's 5173, so a port already held by something else
is a loud bind failure. **That is an environment collision, not a repo defect**
— report it and stop; do not "fix" it by changing the port or the config.
[`docs/dev-loop.md`](docs/dev-loop.md) has the WSL2 trap that makes the holder
invisible to `ss`.

---

## 9. Definition of done

**Run `pnpm verify`.** One command, every gate, cheapest first — so a
line-length error costs seconds instead of a minute behind the e2e suite — and
it reports every failure rather than stopping at the first.
`pnpm verify --quick` skips e2e (what `pre-push` runs); `--bail` stops at the
first failure, for a tight edit loop; `--no-container` drops the Go/Dockerfile
gate, and exists for CI rather than for you.

It runs, in order: `format:check`, `lint:md`, `lint:agents`, `lint:container`,
`lint`, `typecheck`, `test:unit`, `test:e2e`, `build:nocheck`, `deadcode`.

**`pnpm verify` is the whole set; CI just runs it across four machines**, whose
union is exactly the local run — so a gate added to `scripts/verify.js` lands in
CI with nothing else touched.

### Match the gate to what the change touched

`pnpm verify` before anything reaching `main`, and whenever you are unsure.
Below that, run what the change can actually break — a comment in a YAML file
does not need the e2e suite:

| Change touches                          | Run                                         |
| --------------------------------------- | ------------------------------------------- |
| Markdown, config, `.github/`            | `format:check` + `lint:md`                  |
| Shell (`scripts/**.sh`, `.githooks/`)   | `shellcheck -x` on the files                |
| `docker/`, `Dockerfile`, `compose.yaml` | `lint:container` — a **skip is not a pass** |
| `.github/workflows/`                    | `format:check` + `lint:md` + `lint:actions` |
| `client/`, `server/`, `shared/`         | `typecheck` + `test:unit`                   |
| `web/`                                  | `typecheck` + `test:unit` + `test:e2e`      |
| Anything you cannot confidently bound   | `pnpm verify`                               |

`pnpm typecheck` means all three targets, never `typecheck:web` alone (§3).
`pnpm check:fast` is the packaged middle ground and what `pre-push` runs — but
its `--changed` selection reads your _uncommitted_ diff, so it selects nothing
on a clean tree and is not evidence on its own.

Then, before saying it works:

- **New or changed server logic gets a test** in `server/__tests__/`. Server
  code is excluded from `tsc`, so tests are the only thing standing behind it.
- **Report failures as failures.** If a suite is red, say so and paste the
  output. A pipeline like `pnpm test:e2e | tail -5` reports `tail`'s exit code,
  not the suite's — check the real one.
- **State what you did not verify.** In-game behavior, CEF rendering, and
  framework integration are outside the suites. Say so rather than implying
  coverage.
- **Untracked files are not staged.** New directories need an explicit
  `git add`; `git add -u` misses them.

---

## 10. Declaring a service

A service is a named group of server actions backed by a table, declared once
via `server/lib/defineService.ts` rather than hand-writing a repository and an
endpoint. One declaration derives the repository, the write allowlist (§2.9),
the CRUD net events, and the DDL. Its `id` matches the app manifest id and the
`<service>` event segment. What bites if you guess it:

- `id, citizenid, status, created_at, updated_at` are **supplied by the
  framework** — declaring one in `schema` is an error.
- `access` is two independent axes, `read` and `write`. **`read: 'public'`
  requires `paging`** and `defineService` throws without it. **`'members'` and
  `'public'` reads register no generic `get`**; membership needs
  `access.membership`, which derives `Repository.isMember`.
- `access.editWindow` time-boxes an ownership-scoped **update** only — never a
  `delete`. `paging` is always keyset on `id DESC`, never offset. `childTables`
  are **DDL-only**; declare every column explicitly. A public projection
  withholds `citizenid` automatically, and anything else marked `private: true`.
- **Never read another resource's tables** — go through that resource's exports,
  behind a `*Bridge` in `server/lib/`.

The `gphone-service` skill is the working reference and
[`docs/schema-and-services.md`](docs/schema-and-services.md) is the
field-by-field authority. Read the doc before declaring a `read: 'public'` or
`access.membership` service for the first time.

---

## 11. Adding an app

`pnpm new:app <id>` (or `--service` to scaffold the data half too) writes
`web/src/apps/<id>/`. Nothing else registers it; `shell/state/registry.ts`
discovers apps via `import.meta.glob`. The id is lowercase and a **key** —
directory, storage namespace, event segment, keybind claim, deep-link — so
renaming it later is a data migration. Four things bite before you open the
walkthrough:

- **`core` is required** and has teeth: `true` ships with the phone and can't be
  uninstalled; `false` is a Store add-on. Read `manifest.core` and nothing else
  — never infer it.
- **`tile: { bg, fg }` is required too**, and both are utility classes rather
  than colour values — a hex string paints nothing. Omit `fg` on a dark tile;
  state it on a light one, or the glyph is illegible (MICA-88). `defineApp`
  throws on either mistake. The old free-form `color` string is still accepted
  so a published add-on keeps loading, but it is derived from `tile` now — do
  not author it.
- **A NUI round trip touches three files** and fails silently if one is missing
  (§8). `server/__tests__/routes.test.ts` cross-references all three plus the
  browser mock.
- **Load with `onAppForeground`, never `onMount`/`$effect`.** Apps are resident
  and mount once per session, so anything fetched in `onMount` goes stale the
  moment the app backgrounds. The one exception is a manifest `preload`,
  required if the app ships a `badgeStore` (`sdk/appContract.test.ts` enforces
  the pairing) — a badge has to be right before the launcher paints.

The full walkthrough — directory scaffold, every manifest field, the
service/route/store/mock layers, `core: true` vs `false`, the wiring hooks, and
the pre-verify checklist — is
[`docs/writing-an-app.md`](docs/writing-an-app.md). Notes is the smallest
complete example to copy from; Bank is the example with no table.

`pnpm verify` before calling it done (§9). Then run it in game — a green suite
is not evidence a NUI feature works (§6, §8).
