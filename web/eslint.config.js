// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import svelteConfig from './svelte.config.js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

/**
 * web/ has its own eslint + typescript-eslint install, separate from root's —
 * typescript-eslint currently hard-refuses to load at all when it can resolve
 * a TypeScript 7.x anywhere on its module path (AGENTS.md §3: root runs 7.x,
 * web/ runs 6.x on purpose). Running from within web/, with its own
 * node_modules, keeps this resolving 6.x. See ../eslint.config.js and
 * ../.oxlintrc.json for client/server/shared, which can't use this path yet.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'docs/**',
      'playwright-report/**',
      'test-results/**',
      // Built add-on bundles, gitignored — minified output, not source.
      'public/addons/**'
    ]
  },

  // Plain JS build scripts only — .ts/.svelte get their own TS-aware blocks
  // below, and applying base `no-undef`/`no-unused-vars` etc. to them just
  // produces false positives against syntax the base parser can't read.
  {
    files: ['**/*.js', '**/*.mjs'],
    ...js.configs.recommended,
    languageOptions: {
      globals: { ...globals.node }
    }
  },

  {
    files: ['**/*.ts'],
    // e2e/ and playwright.config.ts belong to no tsconfig at all — Playwright
    // transpiles them itself — so `projectService` can't place them and the
    // parser falls over into false positives. They get the syntax-only block
    // below instead of type-checked rules.
    ignores: ['e2e/**', 'playwright.config.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }
      ],
      // Svelte stores and reactive callbacks routinely fire-and-forget a
      // promise on purpose (an unawaited background refresh); this rule
      // can't distinguish that from a genuinely dropped rejection.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      // See the same rule in the .svelte block below: the mock registries and
      // transport interfaces are async by contract, not by need.
      '@typescript-eslint/require-await': 'off'
    }
  },

  {
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },

  // Typed rules for .svelte first, so `svelte.configs.recommended` right
  // after it can win the last-write on `languageOptions.parser` — `extends`
  // here sets that to typescript-eslint's own parser, which would otherwise
  // clobber svelte-eslint-parser and break every .svelte file's parse.
  {
    files: ['**/*.svelte'],
    extends: [tseslint.configs.recommendedTypeChecked],
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      // The mock transport and NUI registries implement an async interface
      // (`ITransportAdapter.send()` returns `Promise<T>`) whether or not a
      // given handler body needs to await anything — real for `web/src/nui/mocks/registry.ts` alone.
      '@typescript-eslint/require-await': 'off',
      // `$props()`/`$state()` destructuring requires `let` (AGENTS.md §4) even
      // when a given binding is never reassigned — Svelte's own reactivity is
      // invisible to this rule's static analysis, so it can't tell the two apart.
      'prefer-const': 'off'
    }
  },

  ...svelte.configs.recommended,

  // Re-applied after svelte.configs.recommended, and touching only
  // `parserOptions` (not `languageOptions.parser` itself) so the svelte
  // parser set just above stays in place while its embedded <script>
  // content still gets delegated to typescript-eslint's parser.
  //
  // `**/*.svelte.ts` (and `.svelte.js`) too — Svelte 5's module-level runes
  // files. `svelte.configs.recommended` sets its own parser for these (a
  // separate config object from the `.svelte` one above), which needs the
  // exact same patch or these files fail to parse at all.
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte'],
        parser: tseslint.parser,
        svelteConfig
      }
    }
  },

  {
    files: ['**/*.test.ts'],
    languageOptions: {
      globals: { ...globals.node }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Mocks routinely return or accept loosely-typed fixtures on purpose —
      // that's test-authoring convenience, not the untrusted-data-flow risk
      // this rule family exists to catch in production code.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      // `expect(obj.method).toHaveBeenCalledWith(...)` reads a method reference without
      // calling it unbound — the exact pattern this rule exists to catch, applied to a
      // spy assertion instead of a real call site.
      '@typescript-eslint/unbound-method': 'off'
    }
  },

  // Must come last: turns off any stylistic rule prettier already owns.
  prettier
);
