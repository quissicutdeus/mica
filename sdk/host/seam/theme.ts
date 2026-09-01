// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

export { DEFAULT_SEED, sanitizeSeed, seedFromRgbString } from '../../lib/seed';
export { backgroundForScheme, buildSchemes, cssVarBlock } from '../../lib/m3';

/**
 * The Material 3 scheme generator, handed to the phone. MICA-181.
 *
 * The shell is what *renders* the design system: `shell/state/theme.ts` turns the player's
 * seed into `schemeStore` and a `style` attribute, `shell/state/wallpaper.ts` turns the same
 * scheme into the home background, and `web/src/host/facets/theme.ts` hands `sanitizeSeed`
 * and `seedFromRgbString` to an app through `useTheme()`. All four reached into
 * `sdk/lib/m3` by relative path until this file existed, which is the edge
 * `lib/ownership.test.ts` rule 5 now refuses.
 *
 * ## Why this is a seam and not a publish
 *
 * Publishing was tried first, and the ticket argued for it: `M3Tokens` is already on both
 * barrels, so the *type* of a scheme is contract while the only way to build one was not,
 * and AGENTS.md section 5 tells app authors to build with the design system. Then it was
 * measured. `export { buildSchemes } from './lib/m3'` on `addon.ts` pulls
 * `@material/material-color-utilities` into **every** add-on bundle, and Rollup does not
 * shake it back out — `pnpm --filter web build:addons` went from 192.30 kB to 296.17 kB for
 * `hodlr` and 176.60 kB to 280.48 kB for `snek`, a snake game that names none of it. That is
 * about 21 kB gzipped on every add-on ever published, forever, in exchange for a capability
 * no add-on in this tree has asked for.
 *
 * So the disclosure question is left open rather than answered by a side effect. An add-on
 * still gets the *current* scheme through `useTheme().schemeStore` — which is what an app
 * theming itself to the phone actually needs — and deriving a scheme from some *other* seed
 * stays unpublished until somebody weighs that 21 kB against a real add-on that wants it.
 * A seam is reversible; an entry on `addon.ts` is not.
 *
 * `sdk/ui/NowPlayingCard.svelte` is the one place inside the package that derives a scheme
 * from a seed, and it is on `@gphone/sdk/core` — core apps only, never bundled into an
 * add-on — which is itself a prior decision pointing the same way.
 *
 * ## Two source modules, one file
 *
 * `lib/seed.ts` is the pure half (MICA-16 step 4 split it out so the iframe theme twin
 * could sanitize a seed without the color engine); `lib/m3.ts` is the engine. They are
 * re-exported together here because the phone loads both regardless — the shell paints the
 * theme. A caller that wants only the seed helpers and must not pay for the engine is the
 * iframe twin, and it imports `lib/seed` directly, inside the package, exactly as before.
 *
 * `ROLE_NAMES`, `TOKEN_NAMES` and the state-layer tables stay off even this list. They are
 * the design system's own vocabulary, `sdk/cef.test.ts` is their in-package consumer, and
 * `version.ts` says outright that the design system is out of contract.
 */
