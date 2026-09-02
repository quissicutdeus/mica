// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process';

/**
 * What the release zip contains and how it is named, kept apart from the packing so
 * `server/__tests__/packResource.test.ts` can hold it on every push. `release.yml` runs on
 * `main` alone, and `packRelease.test.ts` records what a gate that first fires there costs.
 */

/** The CalVer tag `release.yml` cuts: `v2026.09.02.3`. */
export const TAG_PATTERN = /^v(\d{4}\.\d{2}\.\d{2})\.(\d+)$/;

/**
 * The directory at the top of the zip, which is the resource's name once unpacked into
 * `resources/`. Lowercase, matching README's `ensure gphone` and the `gphone:` event prefix.
 */
export const RESOURCE_NAME = 'gphone';

/** Fence the part of README.md the zip carries as its own README. Both must be present. */
export const README_START = '<!-- release-zip:start -->';
export const README_END = '<!-- release-zip:end -->';

/** Files at the repository root that ship beside `dist/`, verbatim (the manifest stamped). */
export const TOP_LEVEL_FILES = ['fxmanifest.lua', 'gphone.sql', 'gphone.esx.sql', 'LICENSE'];

/** The build output the manifest declares, whole. `dist/release` is where the zip lands. */
export const DIST_DIRS = ['dist/client', 'dist/server', 'dist/web'];

/** `v2026.09.02.3` -> `2026.09.02.3`, the version the About screen shows. */
export function calVerOf(tag) {
  const match = TAG_PATTERN.exec(tag ?? '');
  if (!match) {
    throw new Error(
      `expected a CalVer tag like v2026.09.02.3, got ${tag ?? '(nothing)'}. It is the tag ` +
        'release.yml computed, and the zip is named after it.'
    );
  }
  return `${match[1]}.${match[2]}`;
}

export function zipName(tag) {
  return `${RESOURCE_NAME}-${calVerOf(tag)}.zip`;
}

/** Midnight UTC on the tag's date: the one timestamp every entry carries. */
export function releaseDate(tag) {
  const [year, month, day] = calVerOf(tag).split('.').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * The same CalVer `release.yml` and `web/vite.config.ts` compute: the newest commit's date
 * and its position among that day's commits. For a local pack, where there is no tag yet.
 */
export function calVerFromGit() {
  try {
    const dates = execFileSync('git', ['log', '--format=%cd', '--date=format:%Y.%m.%d'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .trim()
      .split('\n');
    const date = dates[0];
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(date)) return '1980.01.01.0';
    return `${date}.${dates.filter((d) => d === date).length}`;
  } catch {
    return '1980.01.01.0';
  }
}

/**
 * The tree's manifest says `version '1.0.0'`, read from `package.json`, which
 * `sdk/version.ts` calls a placeholder read by no code. The zipped copy says the release
 * it is, so `ensure gphone` and `resources` in a server console name a real version.
 * Exactly one `version` line, or this refuses: two would mean the generator changed shape.
 */
export function stampManifestVersion(manifest, version) {
  const lines = manifest.split('\n');
  const hits = lines
    .map((line, i) => (/^version '[^']*'$/.test(line) ? i : -1))
    .filter((i) => i >= 0);
  if (hits.length !== 1) {
    throw new Error(
      `fxmanifest.lua has ${hits.length} \`version '...'\` lines; expected exactly one to stamp.`
    );
  }
  lines[hits[0]] = `version '${version}'`;
  return lines.join('\n');
}

/**
 * The README the zip carries: the fenced part of the repository README, under a header that
 * says which release this is and where the rest of the document lives.
 *
 * The fence is what keeps this honest. Everything between the markers is written for
 * someone holding the zip; the source build, which the zip exists to spare them, sits
 * outside it. `packResource.test.ts` checks the excerpt never tells an owner to run pnpm.
 */
export function readmeExcerpt(readme, { tag, repository }) {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `README.md must carry ${README_START} before ${README_END}; the zip's README is what ` +
        'lies between them.'
    );
  }
  const body = readme.slice(start + README_START.length, end).trim();
  if (!body) throw new Error('README.md has nothing between the release-zip markers.');
  const version = calVerOf(tag);
  return (
    `# gPhone ${version}\n\n` +
    "This is the prebuilt release of gPhone, ready to unpack into a FiveM server's\n" +
    '`resources` directory. What follows is the installation section of the\n' +
    'project README as of this release. The full README, with every convar, the\n' +
    'notes on ESX and on running with no framework, and the exports other\n' +
    `resources can call, is at ${repository}/blob/${tag}/README.md.\n\n` +
    `${body}\n`
  );
}

/**
 * Every path pattern `fxmanifest.lua` declares -- scripts, the UI page, and the `files`
 * block -- so the packer can prove the zip has something behind each. FiveM serves only what
 * the manifest lists and lists only what exists at load, so a directory the build stopped
 * emitting is a resource that starts and then 404s, which is how the add-ons were lost once.
 */
export function manifestGlobs(manifest) {
  const globs = [];
  let inFiles = false;
  for (const raw of manifest.split('\n')) {
    // A Lua comment can hold an apostrophe (`404'd`); strip it before reading quotes.
    const line = raw.replace(/--.*$/, '').trim();
    const script = /^(?:server_script|client_script|ui_page)\s+'([^']+)'/.exec(line);
    if (script) globs.push(script[1]);
    if (/^files\s*\{/.test(line)) inFiles = true;
    else if (inFiles && line.startsWith('}')) inFiles = false;
    else if (inFiles) {
      const entry = /^'([^']+)',?$/.exec(line);
      if (entry) globs.push(entry[1]);
    }
  }
  return globs;
}

/** FiveM's manifest globs: `**` spans directories, `*` stays inside one. */
export function globToRegExp(glob) {
  const source = glob
    .split('/')
    .map((segment) =>
      segment === '**'
        ? '(?:.+)'
        : segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')
    )
    .join('/')
    // `a/**/b` also matches `a/b`, as it does for FiveM.
    .replaceAll('/(?:.+)/', '/(?:.+/)?');
  return new RegExp(`^${source}$`);
}

/** The manifest globs that no packed path satisfies. Empty means the zip is whole. */
export function uncoveredGlobs(manifest, paths) {
  return manifestGlobs(manifest).filter((glob) => {
    const pattern = globToRegExp(glob);
    return !paths.some((path) => pattern.test(path));
  });
}
