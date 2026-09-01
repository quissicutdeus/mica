// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The manifest a release tarball ships, derived from the one in the tree.
 *
 * Two rewrites, and the second is the one that was missing. `version` becomes the release's,
 * replacing `package.json`'s placeholder `1.0.0`. And every `workspace:` dependency spec
 * becomes that same version, because a tarball is not in a workspace and nothing outside one
 * can resolve the protocol.
 *
 * `pack-release.js` used to leave the second to pnpm, on the reasoning — written into
 * `release.yml` — that "`pnpm pack` reads a manifest and archives files, so nothing here
 * needs node_modules". That is true of everything except this: resolving `workspace:*` means
 * looking up the linked package, and with no install there is nothing to look up. The job
 * failed on the first release after `shared/` became a package, with
 * `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`, and it failed on `main` because that is the
 * only place `release.yml` runs — nothing on `dev` or in a PR could have caught it.
 *
 * Doing the rewrite here rather than adding `pnpm install` to the job keeps that property
 * true instead of arguing with it, and makes the pinning explicit: both packages are cut
 * from one tag at one version, so `workspace:*` resolves to exactly that version and a
 * consumer gets two tarballs that agree.
 */

const WORKSPACE = 'workspace:';
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies'
];

/**
 * @param {string} original raw `package.json` text
 * @param {string} version the release version, e.g. `1.20260831.41`
 * @returns {string} the rewritten text, newline-terminated as npm writes it
 */
export function releaseManifest(original, version) {
  const pkg = JSON.parse(original);
  pkg.version = version;

  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && spec.startsWith(WORKSPACE)) deps[name] = version;
    }
  }

  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Whether any dependency field still names the workspace protocol. Used by the suite. */
export function hasWorkspaceSpec(manifestText) {
  const pkg = JSON.parse(manifestText);
  return DEPENDENCY_FIELDS.some((field) =>
    Object.values(pkg[field] ?? {}).some(
      (spec) => typeof spec === 'string' && spec.startsWith(WORKSPACE)
    )
  );
}
