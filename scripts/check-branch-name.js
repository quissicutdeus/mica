// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Judge the branch names a push would create or update (AGENTS.md §12).
 *
 * Used by scripts/pre-push.js, and runnable directly for a quick check:
 *   printf 'HEAD abc refs/heads/junk def\n' | node scripts/check-branch-name.js
 *
 * The REMOTE ref is what gets judged, not the current branch: `git push origin
 * HEAD:refs/heads/MICA-56` is legal from a differently-named local branch,
 * and judging the local one would wrongly refuse it.
 *
 * Deletions are always allowed, whatever the name -- a rule that forbade them
 * would make every branch predating it permanently unremovable, which is the
 * opposite of the point. Tags are not this rule's business either.
 */

const PATTERN = /^(main|dev|MICA-[0-9]+(-[a-z0-9]+)*)$/;
const ZERO = /^0+$/;

/**
 * @param {string} input git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>`
 * @returns {{offenders: string[], updates: number}} `updates` counts refs that are
 *   not deletions -- zero means the push has nothing to verify.
 */
export function judgePush(input) {
  const offenders = [];
  let updates = 0;

  for (const line of input.split('\n')) {
    const [, localSha, remoteRef] = line.trim().split(/\s+/);
    if (!remoteRef || !remoteRef.startsWith('refs/heads/')) continue; // tag, or blank
    if (ZERO.test(localSha ?? '')) continue; // deletion

    updates += 1;
    const name = remoteRef.slice('refs/heads/'.length);
    if (!PATTERN.test(name)) offenders.push(name);
  }

  return { offenders, updates };
}

export function reportOffenders(offenders) {
  console.error('pre-push: branch names must be a MICA ticket key (AGENTS.md 12).\n');
  for (const name of offenders) console.error(`  refused: ${name}`);
  console.error('\n  Allowed: main, dev, MICA-<n>, MICA-<n>-short-slug');
  console.error('  Rename:  git branch -m MICA-56-short-slug');
  console.error('  Bypass:  git push --no-verify');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0); // No stdin (invoked by hand) -- nothing to judge.
  }
  const { offenders } = judgePush(input);
  if (offenders.length > 0) {
    reportOffenders(offenders);
    process.exit(1);
  }
}
