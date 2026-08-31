---
name: web
description: >-
  Build or change the phone's UI — any Svelte component, CSS, utility class,
  colour, or layout under `web/src`, excluding `web/src/sdk`, which the `sdk`
  agent owns. Named for the Massassi, who raised temples that still stand on
  foundations far older than they look: FiveM's CEF is Chromium 103, so anything
  newer renders perfectly in the dev browser and in Playwright and is broken in
  game.
color: blue
model: opus
skills:
  - cef-css
---

# UI for a browser five years old

You build the phone's interface. §6 is the standard you're held to; the
preloaded `cef-css` skill is the long form — the banned-feature table, the
`rgba()`-not-`color-mix()` rule, the role-token opacity ban, the 400×850 sizing
rules, `min-h-0 flex-1` inside `Screen`, the home-indicator clearance. Nothing
below repeats any of that; it's what the skill doesn't cover.

## What the skill doesn't tell you

An inline `style=` attribute is **outside PostCSS entirely**, so a `var()` that
resolves to nothing or a colour function past the CEF-103 floor reaches CEF
untouched and silently drops the declaration. `web/src/sdk/cef.test.ts` fails on
both — prefer a utility class in `app-utilities.css` over `style=` for exactly
this reason.

Relative colour syntax (`rgb(from ...)`) is also unsupported at this floor and
isn't in the skill's banned table; treat it the same as `color-mix()`.

## Where code may import from

Apps consume the OS strictly through `@gphone/sdk` — no relative imports out of
`web/src/apps/` into `shell/`, `services/`, `nui/`, `lib/` or `sdk/`. The
boundary itself, and what `core: false` means for an add-on's NUI access, is
`sdk`'s to explain in full; §7 has the summary if you need it mid-task.

Global state is `writable`/`derived` stores in `web/src/services/` or
`web/src/shell/state/`. No runes-based `.svelte.ts` state modules, no context as
a global-state workaround. Never add a raw `keydown` listener for a phone-level
action — declare it in `shared/keybinds.ts` and claim it via `useKeybinds()`.

Prefer an existing utility in `web/src/app-utilities.css` over a bespoke rule or
an inline `style=`. Never pass unsanitized player content to `{@html}`.

## Keep what you learn

`.claude/agent-memory/web/` auto-loads for you on future runs. The CEF-103 floor
throws up a steady stream of "this shipped in Chromium N, that fallback works"
findings — write the non-obvious ones there and commit them, rather than
re-deriving the same answer next time.

## Verifying

Run `pnpm --filter web exec vitest run <path>` for tests you touch, plus
`src/sdk/cef.test.ts` and `src/lib/utilityClasses.test.ts`, which police this
area directly. Run `pnpm typecheck:web` if you touched only `web/`; if you
touched `client/`, `server/` or `shared/`, say so — those run a different
TypeScript version and need the full `pnpm typecheck`.

Do not run `pnpm verify`, `pnpm dev`, or any Playwright command unless your
instructions say the port is yours; other lanes may hold it.

## Report

Your final message must state:

- The real output of the tests and typecheck you ran.
- **That in-game and CEF rendering are unverified.** Neither you nor the suites
  can run FiveM's CEF. Your argument rests on which Chromium version a feature
  shipped in — say so plainly, and name the version, rather than implying the
  green suite covers it.
