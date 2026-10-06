// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @ts-check

/**
 * The Chromium 103 floor, as stylelint config. Published as `@mica/sdk/stylelint`. MICA-312.
 *
 * FiveM's release CEF is Chromium 103, and anything newer renders perfectly in every browser
 * an author can test in and is broken in game (AGENTS.md §6). This is the one config both
 * sides lint with: micaOS's own `stylelint.config.js` spreads it, and an add-on's
 * `pnpm check` runs it through `checks/cli.js`, so the two cannot disagree about the floor.
 *
 * **The target is written here, not read from a browserslist.** micaOS declares
 * `chrome 103` in its root `package.json`; an add-on's project has no such entry, and the
 * plugin would otherwise fall back to browserslist's defaults — current browsers, which pass
 * everything this exists to refuse.
 *
 * **Spread it, rather than `extends` it**, as `stylelint.config.js` in micaOS does:
 *
 * ```js
 * import cefFloor from '@mica/sdk/stylelint';
 * export default { ...cefFloor, rules: { ...cefFloor.rules } };
 * ```
 *
 * A plugin named by an extended config is resolved from the extended file's own directory,
 * which under pnpm is inside the store and cannot see your `devDependencies`. Spread, the
 * plugin is resolved from your config file, beside your `node_modules`.
 *
 * Needs `stylelint`, `stylelint-no-unsupported-browser-features` and `postcss-html` installed
 * by whoever runs it. Not covered by `SDK_CONTRACT_VERSION`: it is build tooling, never part
 * of a bundle, and a change to it can fail an author's lint but cannot change what an
 * installed add-on does.
 */

/** FiveM's release CEF. */
export const CEF_FLOOR_BROWSERS = ['chrome 103'];

/** @type {import('stylelint').Config} */
const config = {
  plugins: ['stylelint-no-unsupported-browser-features'],
  rules: {
    'plugin/no-unsupported-browser-features': [
      true,
      {
        browsers: CEF_FLOOR_BROWSERS,
        severity: 'error',
        // Each is safe at Chromium 103 though the browser data says otherwise. Anything not
        // listed is enforced, `css-scrollbar` included: `scrollbar-width` alone leaves
        // scrollbars visible in game, so each use carries a disable naming its fallback.
        ignore: [
          // `postcss.config.js` lowers native nesting (Chromium 112) for the phone and the
          // template alike.
          'css-nesting',
          // Reported for `column-gap`, which flex and grid support from Chromium 84; the
          // partial support is multi-column layout's.
          'multicolumn',
          // Reported for `text-decoration-line`, supported from Chromium 57.
          'text-decoration',
          // `ui-monospace`, `ui-serif` and the like: an unknown family falls through to the
          // next one in the stack, so nothing breaks.
          'extended-system-fonts'
        ]
      }
    ],
    'selector-pseudo-class-no-unknown': [
      true,
      {
        // Svelte's scoping escapes, not browser pseudo-classes.
        ignorePseudoClasses: ['global', 'svelte']
      }
    ]
  },
  /**
   * `postcss-html` for markup only, never at the top level. Applied to a `.css` file it
   * parses the stylesheet as HTML, finds no `<style>` in it, and hands stylelint nothing to
   * read: every `.css` file comes back clean whatever it holds. That was the state of this
   * repo's `lint:css` until MICA-312 — `--custom-syntax postcss-html` on the command line
   * and here — so no `.css` file had ever been checked against the floor.
   */
  overrides: [
    {
      files: ['**/*.svelte', '**/*.html'],
      customSyntax: 'postcss-html'
    }
  ]
};

export default config;
