// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import cefFloor from './sdk/checks/stylelint.config.js';

/**
 * The CEF floor is `@mica/sdk/stylelint` (`sdk/checks/stylelint.config.js`), the same config
 * an add-on's `pnpm check` runs, so the phone and every add-on lint against one definition
 * of Chromium 103 (MICA-312). Spread rather than `extends`ed, so the plugin resolves from
 * here; that file says why. What is below is this repo's own.
 *
 * @type {import('stylelint').Config}
 */
export default {
  ...cefFloor,
  ignoreFiles: [
    'dist/**',
    'node_modules/**',
    'web/public/**',
    'sdk/dist/**',
    '.claude/**',
    // TypeDoc's output, gitignored: generated locally, never shipped, absent in CI.
    'web/docs/**',
    // The mica.gg landing page, served to ordinary browsers rather than FiveM's CEF.
    'docker/landing/**'
  ],
  rules: {
    ...cefFloor.rules,
    // Disable style-related rules that conflict with existing code
    // The gate is about browser feature support, not code style
    'at-rule-empty-line-before': null,
    'rule-empty-line-before': null,
    'comment-empty-line-before': null,
    'no-descending-specificity': null,
    'selector-class-pattern': null,
    'custom-property-pattern': null,
    'at-rule-no-unknown': [
      true,
      {
        ignoreAtRules: ['container']
      }
    ]
  }
};
