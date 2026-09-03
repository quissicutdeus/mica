// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// @ts-expect-error -- a plain .js build script with no types; this suite is not typechecked.
import { releaseManifest, hasWorkspaceSpec } from '../../scripts/lib/release-manifest.js';

/**
 * What a release tarball declares, checked on every push rather than on `main` alone.
 *
 * `release.yml` runs on `main` and nowhere else, so the first time it saw `@gos/sdk`
 * depend on `@gos/shared` through `workspace:*` was the release itself, which failed with
 * `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`. The job deliberately skips `pnpm install` —
 * "`pnpm pack` reads a manifest and archives files" — and that is true of everything except
 * resolving the workspace protocol, which needs the linked package to be installed.
 *
 * Nothing on `dev` or in a pull request could have caught it, which is the actual defect:
 * a gate that only ever runs at the last possible moment is one that reports a break after
 * the release is already cut. This suite is the dev-side half.
 */

const ROOT = resolve(__dirname, '../..');
const VERSION = '1.20260831.41';

/** The packages `pack-release.js` ships. Both, always — the SDK's dependency is the other. */
const PACKAGES = ['sdk', 'shared'];

const manifestOf = (dir: string): string => readFileSync(join(ROOT, dir, 'package.json'), 'utf8');

describe('the manifest a release tarball ships', () => {
  it('stamps the release version over the placeholder in package.json', () => {
    const packed = JSON.parse(releaseManifest(manifestOf('sdk'), VERSION));

    expect(packed.version).toBe(VERSION);
  });

  /**
   * The canary. A tarball is not in a workspace, so `workspace:*` is unresolvable to anyone
   * who installs it — and unresolvable to `pnpm pack` itself without an install. If this
   * ever fails, the release job fails with it.
   */
  it.each(PACKAGES)('leaves no workspace protocol in %s', (dir) => {
    expect(hasWorkspaceSpec(releaseManifest(manifestOf(dir), VERSION))).toBe(false);
  });

  it('still has a workspace spec to rewrite, so the check above is doing something', () => {
    // If the SDK ever stops depending on `shared` through the workspace protocol this test
    // fails, which is the signal to ask whether the rewrite is still needed rather than to
    // keep a check that has quietly stopped checking.
    expect(hasWorkspaceSpec(manifestOf('sdk'))).toBe(true);
  });

  it('pins a workspace dependency to the very version being published', () => {
    // Both packages are cut from one tag, so the SDK's tarball asks for exactly the `shared`
    // tarball published beside it. Anything else is a consumer resolving a version that no
    // release provides.
    const packed = JSON.parse(releaseManifest(manifestOf('sdk'), VERSION));

    expect(packed.dependencies['@gos/shared']).toBe(VERSION);
  });

  it('leaves an ordinary version range alone', () => {
    const packed = JSON.parse(
      releaseManifest(
        JSON.stringify({
          name: '@gos/sdk',
          version: '1.0.0',
          dependencies: { '@gos/shared': 'workspace:*', marked: '^18.0.11' },
          peerDependencies: { svelte: '^5.46.4' }
        }),
        VERSION
      )
    );

    expect(packed.dependencies.marked).toBe('^18.0.11');
    expect(packed.peerDependencies.svelte).toBe('^5.46.4');
  });
});
