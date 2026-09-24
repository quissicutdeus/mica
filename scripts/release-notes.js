// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';

import { releaseNotesFor } from './lib/release-notes.js';

/**
 * CLI: print a release's notes body, derived from CHANGELOG.md, to stdout.
 *
 * `release.yml` runs `node scripts/release-notes.js "$TAG" > release-notes.md` and hands the
 * file to `gh release create --notes-file release-notes.md --generate-notes`, which prepends
 * it to GitHub's own commit-list notes rather than replacing them (verified against `gh
 * release create --help` and the CLI's own source — MICA-221).
 *
 * A tag that does not parse, or a CHANGELOG.md whose structure `lib/release-notes.js` does
 * not recognise, is a non-zero exit and nothing on stdout — never an empty release body. Run
 * from the repo root, same assumption `pack-release.js` makes about `sdk/version.ts`.
 */

const tag = process.argv[2];
if (!tag) {
  console.error('release-notes: usage: node scripts/release-notes.js <tag>');
  process.exit(1);
}

const repo = process.env.GITHUB_REPOSITORY || 'quissicutdeus/mica';

try {
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  process.stdout.write(releaseNotesFor(tag, changelog, repo));
} catch (err) {
  console.error(`release-notes: ${err.message}`);
  process.exit(1);
}
