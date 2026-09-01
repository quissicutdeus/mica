// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The notice every bundle this repo emits carries, and the plugin that puts it on the ones
 * esbuild does not build.
 *
 * MICA-192. Built output is the distribution case the licence cares most about, and it
 * shipped with none: a server owner handed `dist/` had nothing in it saying what the code
 * is, who holds the copyright, under what terms, or where the source lives. Those four
 * facts, on one line, are what a reader of a minified file can actually use — the full
 * "Appropriate Legal Notices" AGPL asks for belong on an interactive display, which is
 * Settings > About, not the top of a bundle nobody reads.
 *
 * `/*!` rather than `/*` because a minifier keeps the first and drops the second. That makes
 * survival a property of the banner rather than of whichever minify flags a build happens to
 * carry today.
 *
 * ## Why a plugin and not `output.banner`
 *
 * Vite 8 bundles rolldown, and `build.rollupOptions.output.banner` is silently ignored by
 * it: setting it changed nothing in 28 emitted chunks while esbuild's own `banner` worked
 * on the two it builds. That is exactly the failure MICA-192 warns about — "do not claim
 * success from the config change alone" — and it is only visible by grepping the output.
 * `generateBundle` runs after the chunks exist and is answerable to no bundler's option
 * naming, so it works the same under rollup, rolldown or whatever follows.
 *
 * ## One string, three builds
 *
 * `build-bundle.js` (client and server), `web/vite.config.ts` (the phone) and
 * `web/vite.addon.config.ts` (each add-on) all read it from here. Three copies of a
 * copyright line is three things to update and two of them will be wrong; the `.d.ts` beside
 * this file exists so the two TypeScript configs can import it without `TS7016`.
 */

export const LICENSE_BANNER =
  '/*! gPhone | Copyright (C) 2026 quissicutdeus | AGPL-3.0-or-later | https://github.com/quissicutdeus/gPhone */';

/**
 * Prepend the banner to every emitted JavaScript chunk.
 *
 * Chunks only: an asset is a font, an image or a stylesheet, and a JS comment at the top of
 * a `.woff2` is a corrupt font. CSS carries its own notice through the `.css` files the SDK
 * ships, which already have SPDX headers.
 */
export function licenseBanner() {
  return {
    name: 'gphone-license-banner',
    enforce: 'post',
    /**
     * `order: 'post'`, not a plain `generateBundle` — the same trap `vite.addon.config.ts`
     * documents for its own CSS inliner, and one this plugin fell into first time out.
     *
     * `enforce: 'post'` only places the plugin late in the array. The hook itself still runs
     * at the normal stage, which is *before* every post-stage hook — including Vite's own
     * `__vite__mapDeps` prologue on the entry chunk and the add-on config's CSS injector.
     * Both prepend to `chunk.code`, so a banner added at the normal stage ends up buried on
     * line 3 of five files while looking correct in the other twenty-nine. Only grepping the
     * output shows it.
     */
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== 'chunk') continue;
          if (chunk.code.startsWith(LICENSE_BANNER)) continue;
          chunk.code = `${LICENSE_BANNER}\n${chunk.code}`;
        }
      }
    }
  };
}
