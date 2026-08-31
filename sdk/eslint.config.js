// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import svelteConfig from './svelte.config.js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

/**
 * The SDK's own flat config. MICA-172.
 *
 * **Its own, rather than extending `web/`'s, on purpose.** This package must not depend on
 * its consumer — that inversion is the whole subject of this ticket, and a lint config is
 * not exempt from it just because it is tooling. `sdk/` having to reach into `web/` to know
 * how to lint itself would be the same edge the source spent five phases removing, and it
 * would break the moment this package is consumed by anything that is not this phone.
 *
 * It also has to be its own install for a harder reason, the same one `web/eslint.config.js`
 * documents: typescript-eslint hard-refuses to load when it can resolve TypeScript 7.x
 * anywhere on its module path, and root runs 7.x while this package and `web/` run 6.x
 * (AGENTS.md §3). Running from within `sdk/`, against `sdk/node_modules`, is what keeps this
 * resolving 6.x.
 *
 * The cost is real and worth naming: this file and `web/eslint.config.js` are near-copies
 * and can drift. The alternative — one config reaching across a package boundary — trades a
 * drift risk for a dependency inversion, and this repo has spent this whole ticket paying
 * down the second. If the two do drift, the fix is to lift the shared blocks into a config
 * package that both depend on, not to point one at the other.
 *
 * No `e2e`/`playwright` block: those live in `web/` and the SDK has neither.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**']
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
