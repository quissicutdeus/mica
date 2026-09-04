/**
 * Lowers modern CSS to FiveM's CEF baseline, Chromium 103.
 *
 * **This file is not optional and it is not a formality.** The SDK's own stylesheet —
 * which your bundle inlines, because the add-on iframe has no `<link>` to load one from —
 * uses native CSS nesting in thirty-odd places (`app-utilities.css`). Native nesting
 * shipped in Chromium 112. Without the `nesting-rules` transform below, every one of those
 * blocks is dropped by CEF's parser: your add-on renders correctly in `vite preview`,
 * correctly in any browser you test it in, and wrong in game, with nothing in any test
 * suite able to see the difference.
 *
 * micaOS's own add-on build gets this by accident — `web/postcss.config.js` sits at the
 * root Vite discovers from, so it applies to the shell build and the add-on build alike.
 * Out of tree there is nothing to inherit it from, so it is here explicitly.
 *
 * `oklab-function` with `preserve: true` covers the same ground for `oklab()`/`oklch()`,
 * which reached Chromium at 111. `autoprefixer` is largely redundant against a target this
 * old but is harmless; micaOS keeps it for the same reason.
 */
export default {
  plugins: {
    'postcss-preset-env': {
      features: {
        'oklab-function': { preserve: true },
        'color-functional-notation': { preserve: true },
        'nesting-rules': true
      }
    },
    autoprefixer: {}
  }
};
