// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';

/**
 * Reject AI attribution in commit messages (AGENTS.md §10).
 *
 * There is already a machine-wide version of this guard installed via a global
 * `core.hooksPath` on the maintainer's box, and this does not replace it — that
 * one covers every repo, this one covers every *machine*. A hook living in one
 * checkout's dotfiles cannot police a commit made somewhere else: a cloud
 * coding-agent session runs on a different host with no dispatcher and no
 * ~/.config, and §10 on its own did not stop eight such trailers landing on
 * `dev` (they were caught before being pushed, and rewritten out).
 *
 * Installed by `prepare` -> scripts/install-git-hooks.js on every `pnpm
 * install`, so it travels with the repo to wherever the commit is made. The
 * global dispatcher chains to repo-local hooks, so the two compose rather than
 * collide; with no dispatcher present, git's default .git/hooks lookup finds
 * this directly.
 *
 * Deliberate bypass: git commit --no-verify
 */

// A superset of the machine-wide hook's pattern. `Claude-Session:` and the
// claude.ai/code session URL are the additions: the global pattern matches
// claude.com/claude-code but not claude.ai/code, so a bare session trailer with
// no accompanying Co-Authored-By line slips past it. Every commit this repo
// actually had carried both, so nothing was missed in practice -- but the
// narrower pattern is one trailer-format change away from being wrong.
const PATTERN =
  /Co-[Aa]uthored-[Bb]y:.*(Claude|Anthropic|Copilot|ChatGPT|OpenAI|Cursor|Codex|Gemini|Devin|Aider)|Assisted-[Bb]y:.*(Claude|Anthropic)|noreply@anthropic\.com|🤖|[Gg]enerated with \[?Claude|claude\.com\/claude-code|claude\.ai\/code|Claude-Session:|anthropic\.com/;

const msgPath = process.argv[2];
if (!msgPath) {
  console.error('check-commit-msg: no message file given (expected $1 from the hook)');
  process.exit(2);
}

// Drop the comment lines git appends to the editor buffer; they are not committed.
const body = fs
  .readFileSync(msgPath, 'utf8')
  .split('\n')
  .filter((line) => !line.startsWith('#'));

const hits = body.map((line, i) => [i + 1, line]).filter(([, line]) => PATTERN.test(line));

if (hits.length > 0) {
  console.error('commit-msg: refusing AI attribution in the commit message.\n');
  for (const [n, line] of hits) console.error(`  line ${n}:${line}`);
  console.error('\n  Remove it, or bypass on purpose with: git commit --no-verify');
  process.exit(1);
}
