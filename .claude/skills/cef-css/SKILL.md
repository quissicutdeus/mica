---
name: cef-css
description:
  Write CSS, colour, or layout for the phone UI. Use before adding any style,
  utility class, token, or sizing rule under web/src — FiveM's CEF is Chromium
  103, so modern CSS renders perfectly in the dev browser and in Playwright and
  is broken in game.
---

# CSS for CEF

**FiveM's release CEF is Chromium 103.** Your dev browser is current. Anything
newer than 103 passes `pnpm dev`, passes Playwright, and is broken in game.
Nothing in the automated suite catches this class of bug.

A CEF upgrade (M140/M144) is in progress upstream but not in the release client.
Assume 103.

## Never delete `web/postcss.config.js`

It looks redundant — plain CSS, no framework. It is load-bearing:

- transpiles native CSS nesting (Chrome 112) down to flat selectors via
  `postcss-preset-env`'s `nesting-rules`
- transforms `oklab()`/`oklch()` to a fallback, `preserve: true`

`autoprefixer` alongside it is largely redundant against this target but
harmless; leave it. (AGENTS.md §2.3 — a hard constraint.)

## Banned outright — no fallback exists

| Feature           | Needs      | Instead                                                                       |
| ----------------- | ---------- | ----------------------------------------------------------------------------- |
| `:has()`          | Chrome 105 | Svelte state                                                                  |
| Container queries | Chrome 105 | Svelte state                                                                  |
| `dvh` / `svh`     | Chrome 108 | a measured pixel value — `shell/state/display.ts` tracks `window.innerHeight` |
| `color-mix()`     | Chrome 111 | a literal `rgba()`                                                            |

**Opacity is a literal `rgba()`, never `color-mix()`.** The opacity classes in
`app-utilities.css` (`bg-black/40`, …) and the translucent tokens in `app.css`
(`--color-scrim`, …) are hand-written `rgba()`, CEF-103-safe outright. Add a
literal utility or token rather than reaching for `color-mix()`.

**A themed role token never takes an opacity modifier** (`bg-surface/50`).
`sdk/cef.test.ts` enforces this against `ROLE_NAMES` — a role's alpha would have
to derive from one seed's literal and would be silently wrong under any other.
Use the pre-composited state-layer tokens (`--color-surface-container-hover`,
…).

Native CSS nesting **is** fine — postcss handles it.

## Other CEF constraints

- The app wrapper keeps `bg-transparent`. The game renders behind the overlay;
  an opaque background blacks out the player's screen.
- **Never** `window.location`, `window.open`, or anchor navigation. A redirect
  reloads the whole CEF instance and drops all state. Navigate via Svelte.
- Resources are served over `https://cfx-nui-<resource>/`, not `nui://`.

## Where styles live

- `sdk/app.css` — Material 3 tokens (`--color-*`, `--radius-*`, `--text-*`,
  `--shadow-elevation-*`, `--duration-*`, `--ease-*`) plus the few rules that
  don't fit the utility model.
- `sdk/app-utilities.css` — hand-authored flat utilities, one class per call
  site, each resolving to a token. **Check for an existing class before
  inventing one**; prefer the existing scale over an arbitrary value; add a
  class here rather than an inline `style=`.
- A component `<style>` block only for what a utility genuinely can't express
  (keyframes tied to one component, a pseudo-element). No CSS modules, no
  styled-components.
- **No visible scrollbars anywhere** — enforced globally in `app.css`.

## Sizing

**The screen is a fixed size per device — 400×850 on the phone, 1280×800 on the
tablet (`shared/devices.ts`) — and an app must not try to be responsive.** Those
numbers live in the `DEVICES` table and nowhere else; `shell/state/device.ts`
says which device is up and `shell/state/display.ts` decides its zoom.
Settings > Display resizes the frame with one `transform: scale()` on a wrapper
in `Shell.svelte`, per device — a zoom, so the layout is identical at every
size. Breakpoints (`sm:`, `md:`) and viewport units (`vh`, `vw`, `dvh`) respond
to the _window_, which is not the phone, so they are always wrong. Size against
the frame: `h-full`, `flex-1`, and the `safe-top` / `safe-bottom` insets.

**Inside `Screen`, fill with `min-h-0 flex-1` — never `h-full`, never bare
`flex-1`.** `Screen`'s content box hands the app a definite height. `h-full` is
a percentage against a box that already resolved; `flex-1` alone leaves
`min-height: auto` intact so the child is sized by its content and refuses to
shrink. Both fail silently and only under enough content — MICA-89 was a
composer drifting ~82px per message and another sitting 4000px below the screen.
A box declaring `overflow-y-auto` is exempt and scrolls itself. Reasoning is in
`Screen.svelte`; enforced in `web/src/lib/utilityClasses.test.ts`.

**Anything anchored to the bottom clears the home indicator.** `PhoneFrame`
paints its gesture bar full-width at `z-60`, so a flush row has its lower third
inside a button that returns home. `--spacing-home-indicator` is the shared
number; `MessageBar` (`sdk/ui`) already pads by it.

## Verifying

Manual, and there is no substitute: `nui_devTools` in the F8 console (developer
mode on), or `http://localhost:13172/` while the game runs. Inspect the element
and confirm the **computed** value resolved — not just that the declaration is
present. If you did not do this, say the change is unverified in CEF.
