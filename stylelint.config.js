// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** @type {import('stylelint').Config} */
export default {
  plugins: ['stylelint-no-unsupported-browser-features'],
  customSyntax: 'postcss-html',
  ignoreFiles: ['dist/**', 'node_modules/**', 'web/public/**', 'sdk/dist/**', '.claude/**'],
  rules: {
    // The primary gate: enforce Chromium 103 compatibility for all CSS features
    'plugin/no-unsupported-browser-features': [
      true,
      {
        // Browserslist is read from package.json, targeting Chromium 103
        // This rule enforces that all CSS features are supported in that version
        severity: 'error',
        // Rules that are safe due to postcss transpilation
        ignore: [
          'css-nesting' // postcss.config.js transpiles nesting
        ]
      }
    ],
    // Disable style-related rules that conflict with existing code
    // The gate is about browser feature support, not code style
    'at-rule-empty-line-before': null,
    'rule-empty-line-before': null,
    'comment-empty-line-before': null,
    'no-descending-specificity': null,
    'selector-class-pattern': null,
    'custom-property-pattern': null,
    'selector-pseudo-class-no-unknown': [
      true,
      {
        // Svelte-specific pseudo-classes
        ignorePseudoClasses: ['global', 'svelte']
      }
    ],
    'at-rule-no-unknown': [
      true,
      {
        ignoreAtRules: ['container']
      }
    ]
  },
  overrides: [
    {
      files: ['**/*.svelte'],
      customSyntax: 'postcss-html'
    }
  ]
};
