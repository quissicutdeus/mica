// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { judgePush, reportOffenders } from './check-branch-name.js';

/**
 * The pre-push hook: enforce AGENTS.md §12 branch naming, then run the fast
 * verify gate -- but only when the push actually carries commits.
 *
 * The `updates === 0` early exit is the point of this file existing rather than
 * chaining the two commands with `&&` in package.json. A delete-only push
 * (`git push origin --delete some-branch`) has nothing to typecheck: it
 * introduces no code, and every ref in it is a deletion. Running `check:fast`
 * there costs minutes of barrel generation, three typecheckers and two Vitest
 * projects to verify a tree the push does not touch -- long enough that the
 * first attempt at deleting a branch here timed out before git ever got to do
 * the deletion. Now it is a no-op that returns immediately.
 *
 * Deliberate bypass: git push --no-verify
 */

let input = '';
try {
  input = fs.readFileSync(0, 'utf8');
} catch {
  input = '';
}

const { offenders, updates } = judgePush(input);

if (offenders.length > 0) {
  reportOffenders(offenders);
  process.exit(1);
}

if (updates === 0) {
  console.error('pre-push: deletion only, nothing to verify.');
  process.exit(0);
}

const result = spawnSync('pnpm', ['check:fast'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
