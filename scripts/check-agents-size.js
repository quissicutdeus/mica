// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `AGENTS.md` has a ceiling, and nothing used to notice it approaching.
 *
 * It reached 55,831 characters before anyone looked. Nothing was wrong with any individual
 * paragraph — every addition was a real rule or a real reason — but the file is loaded in
 * full at the start of every session, and past a certain size the thing that suffers is the
 * reader rather than the disk. Detail that is true for one kind of work belongs in a skill
 * (`.claude/skills/`) or a doc, with a pointer left behind; `AGENTS.md` keeps what is true
 * for every task.
 *
 * Two thresholds, because a gate that only ever fires as a failure fires too late to be
 * useful: you find out at the moment you least want to stop and restructure. WARN is
 * advisory and passes; LIMIT fails.
 *
 * The check is loud when it cannot run. A missing or unreadable `AGENTS.md` exits non-zero
 * rather than skipping, per the rule this repo keeps relearning: a check that stays silent
 * when it cannot run reads as a pass.
 *
 *   node scripts/check-agents-size.js            the gate
 *   node scripts/check-agents-size.js <path>     check some other file (for proving it fires)
 */

/** Fail above this. Chosen with room under it rather than at the current size. */
const LIMIT = 40_000;

/**
 * Warn above this, and still pass.
 *
 * Sits ~500 characters above the file's size at the time the cap was introduced, so it is
 * silent today and speaks up on roughly the next section-sized addition — early enough that
 * moving something out is a small job rather than a rewrite.
 */
const WARN = 39_500;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ?? join(ROOT, 'AGENTS.md');

let size;
try {
  // Characters, not bytes on disk, and the two differ here: AGENTS.md contains § and em
  // dashes. The reader's cost is characters, so that is what is measured.
  size = readFileSync(target, 'utf8').length;
} catch (error) {
  console.error(`[agents-size] cannot read ${target}: ${error.message}`);
  console.error('[agents-size] refusing to pass a check that could not run.');
  process.exit(1);
}

const report = `${size.toLocaleString()} characters (limit ${LIMIT.toLocaleString()})`;

if (size > LIMIT) {
  console.error(`[agents-size] ${target} is too long: ${report}.`);
  console.error(
    '[agents-size] Move detail that is true for only one kind of work into the skill or\n' +
      '[agents-size] doc that covers it, and leave a one-line pointer behind. A rule whose\n' +
      '[agents-size] existence stops being visible is worse than a long file.'
  );
  process.exit(1);
}

if (size > WARN) {
  console.warn(`[agents-size] ${target} is approaching the cap: ${report}.`);
  console.warn('[agents-size] Move the next section out rather than adding to this one.');
}

process.exit(0);
