# TypeScript is split by package, and why it stays that way

This repo runs **two TypeScript major versions at once**. AGENTS.md §3 is the
rule that follows from it; this file is the reasoning underneath, and the list
of things that bite when you assume one compiler checks everything.

| Package                     | Version               | Checked by                                     |
| --------------------------- | --------------------- | ---------------------------------------------- |
| root (`client/`, `server/`) | **7.x** (Go-native)   | `tsc --noEmit -p <target>/tsconfig.json`       |
| `web/`                      | **6.x** (JS-based)    | `svelte-check` + `tsc -p tsconfig.node.json`   |
| `sdk/`                      | **6.x** _and_ **7.x** | `svelte-check` whole; `tsc` over its pure core |

Deliberate, not drift. TypeScript 7.0 ships without a stable programmatic
compiler API, and `svelte-check` (via `svelte2tsx`) requires it; that API lands
in 7.1. `client/` and `server/` are plain `tsc` with no Svelte involvement, so
they get the native compiler now and `web/` waits.

- **Do not "align" the versions.** Bumping `web/` to 7 breaks
  `pnpm typecheck:web`. Dropping root to 6 discards the reason the split exists.
- **`sdk/` is pinned for its own reason, not an inherited one** (MICA-172). It
  ships 85 Svelte components, so it needs `svelte-check` exactly as `web/` does.
  The two unblock at 7.1 together; neither can move first.
- **`sdk/`'s 165 non-Svelte `.ts` files are _also_ checked by TS 7**
  (`sdk/tsconfig.tsc.json`, run by `typecheck:sdk` — MICA-184). Additive, not a
  partition: `svelte-check` still covers the package whole, so a file leaving
  the TS 7 set loses strictness, never checking. **That drift is silent in both
  directions** — `svelte/types` declares `*.svelte` ambiently, so `tsc` does
  _not_ error on a component import. `scripts/check-sdk-partition.js` derives
  the split and is the only thing that reports it; it runs first.
- **`client/` and `server/` are checked more strictly than `web/`.** TS 7 makes
  `strict` and the 6.0 deprecations hard defaults. Code that passes in `web/`
  may fail in `client/`. `server/` runs on Node 22 and targets ES2023; `client/`
  stays ES2021, because FiveM's client V8 is not Node (MICA-199).
- **`@shared/types` is a tsconfig path alias, not a workspace package.** It
  appears in no `dependencies` block and `pnpm add @shared/types` will fail. TS
  7 removed `baseUrl`, so path mappings in `client/` and `server/` must be
  relative to their own tsconfig.
- **`client/` and `server/` are plain directories**, not workspace packages —
  they share root's `node_modules`. Only `web/` is a separate pnpm project.
- **Editor errors may disagree with CLI errors** in `web/` and `sdk/`. **The CLI
  is authoritative**; the restart that fixes it is in
  [`docs/dev-loop.md`](docs/dev-loop.md).

## What unblocks the upgrade

**The trigger is `svelte-check`, not TypeScript.** 7.1's bare `typescript`
import returns only a version string — its API lives under `typescript/sync`,
`typescript/async` and friends — while `svelte-check`, `svelte2tsx` and
`typescript-eslint` still load the 6.0 API and cap their peers there. Watch for
a `svelte-check` release built on the 7.1 API; then bump it, move `web/` **and**
`sdk/` together — neither can go first — and delete this file along with
AGENTS.md §3.

Tried against 7.1.0-beta with `svelte-check` 4.7.7 on 2026-10-28, and not ready:
`--tsgo-experimental-api` crashes on start
(`Invalid filesystem callback 'directoryExists'`), and `--tsgo` runs but never
loads a `.svelte` file outside the package, so every `@mica/sdk` component
`web/` renders is checked through the ambient shim and its props go unchecked.
Both still need 6.x installed beside 7. The two tree fixes that run surfaced
(`typeRoots` in `web/` and `sdk/`, `loadImage`'s `crossOrigin`) are already in.
