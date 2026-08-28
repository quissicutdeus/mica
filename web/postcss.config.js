/**
 * Lowers modern CSS to FiveM's CEF baseline, Chromium 103 (AGENTS.md §6).
 *
 * Each entry, what it actually emits, and which of them a CEF upgrade retires is
 * in `docs/cef-baseline.md` (MICA-67). Two notes from there worth having at
 * hand before editing this file:
 *
 * - `color-functional-notation` is already redundant — space-separated `rgb()`
 *   has been supported since Chromium 65, and it is not what makes `lib/m3.ts`
 *   write legacy comma syntax (inline styles never reach PostCSS at all).
 * - `nesting-rules` is safe to drop at Chromium 112 only because every nested
 *   block in this repo is `&`-prefixed. Bare-element nesting needs 120, and
 *   nothing enforces the convention.
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
