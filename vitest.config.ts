import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Root Vitest project — covers `server/` and `client/`. `web/` has its own Vitest
 * project (jsdom, Svelte plugin, browser resolve conditions); this one runs in node
 * with no plugins, because both FiveM targets are plain TypeScript against the same
 * runtime globals.
 *
 * Tests live in `<target>/__tests__/`, which both `server/tsconfig.json` and
 * `client/tsconfig.json` already exclude — so `pnpm typecheck` stays a pure check
 * of shipping code and needs no changes to accommodate test-only globals.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'shared')
    }
  },
  test: {
    environment: 'node',
    include: ['server/__tests__/**/*.test.ts', 'client/__tests__/**/*.test.ts'],
    setupFiles: ['./server/__tests__/setup.ts']
  }
});
