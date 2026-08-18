/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';
import { execSync } from 'child_process';
import pkg from '../package.json' with { type: 'json' };

function getGitInfo() {
  const envBranch = process.env.GITHUB_REF_NAME;
  const envCommit = process.env.GITHUB_SHA ? process.env.GITHUB_SHA.substring(0, 7) : null;

  if (envBranch && envCommit) {
    return { commit: envCommit, branch: envBranch };
  }

  try {
    const commit = execSync('git rev-parse --short HEAD').toString().trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    return { commit, branch };
  } catch {
    return { commit: 'dev', branch: 'main' };
  }
}

const gitInfo = getGitInfo();
const version = pkg.version || '1.0.0';
const buildInfo = `v${version} (${gitInfo.branch}@${gitInfo.commit})`;

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  base: './',
  define: {
    __MICA_VERSION__: JSON.stringify(version),
    __MICA_BUILD_INFO__: JSON.stringify(buildInfo)
  },
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, '../shared'),
      // Before the bare `@gphone/sdk` entry, and it has to stay there: aliases are tried
      // in order, and the shorter key matches this specifier as a prefix — resolving it
      // to `src/sdk/index.ts/testing`, which is not a path.
      '@gphone/sdk/testing': path.resolve(import.meta.dirname, './src/sdk/testing.ts'),
      // The leaf a manifest imports. Same ordering rule as above, and the reason it exists
      // is in `src/sdk/app.ts`: a manifest that imports the full barrel closes a cycle,
      // because the barrel reaches the registry and the registry globs every manifest.
      '@gphone/sdk/app': path.resolve(import.meta.dirname, './src/sdk/app.ts'),
      '@gphone/sdk': path.resolve(import.meta.dirname, './src/sdk/index.ts')
    },
    conditions: ['browser']
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    target: 'chrome92',
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT') return;
        warn(warning);
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            return 'vendor';
          }
        }
      }
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    server: {
      deps: {
        // `@material/material-color-utilities@0.4.0` ships extensionless relative
        // imports inside its own ESM (`from '../dynaminccolor/dynamic_color'`, no
        // `.js`). Node's ESM resolver requires the extension and throws
        // ERR_MODULE_NOT_FOUND on import; Vite's resolver fills it in from
        // `resolve.extensions`. Inlining routes the package through Vite in tests, so
        // the suite resolves it the same way the browser build already does. Not a
        // workaround for our code — the published package is malformed.
        inline: ['@material/material-color-utilities']
      }
    }
  }
});
