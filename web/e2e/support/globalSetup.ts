import { rmSync } from 'node:fs';
import type { FullConfig } from '@playwright/test';

/**
 * `web/test-results/` accumulates a directory per failed test — screenshots,
 * `error-context.md`, and now a trace zip each (`retain-on-failure`) — and nothing
 * cleared it between runs. A run filtered to one spec only touches that spec's own
 * directory, so everything else left over from an earlier run just sits there; while
 * debugging MICA-36 an `error-context.md` from ten minutes and one code change earlier
 * was read as describing the run that had just failed.
 *
 * Wiping every project's output directory before anything runs — whole suite or one
 * filtered spec, `pnpm test:e2e` or a bare `playwright test <path>` — is what makes
 * "whatever's in test-results" always mean "this run." `.gitignore` already covers the
 * directory, so this is purely local disk hygiene, never anything reaching a commit.
 */
export default function globalSetup(config: FullConfig) {
  for (const dir of new Set(config.projects.map((project) => project.outputDir))) {
    rmSync(dir, { recursive: true, force: true });
  }
}
