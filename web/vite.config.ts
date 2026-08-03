/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { execSync } from 'child_process';
import pkg from '../package.json';

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
  plugins: [svelte(), tailwindcss()],
  base: './',
  define: {
    __MICA_VERSION__: JSON.stringify(version),
    __MICA_BUILD_INFO__: JSON.stringify(buildInfo)
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
      // Before the bare `@gphone/sdk` entry, and it has to stay there: aliases are tried
      // in order, and the shorter key matches this specifier as a prefix — resolving it
      // to `src/sdk/index.ts/testing`, which is not a path.
      '@gphone/sdk/testing': path.resolve(__dirname, './src/sdk/testing.ts'),
      '@gphone/sdk': path.resolve(__dirname, './src/sdk/index.ts')
    },
    conditions: ['browser']
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    target: 'chrome92'
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts']
  }
});
