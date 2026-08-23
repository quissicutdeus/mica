import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * `simple-git-hooks` writes into `<projectRoot>/.git/hooks` by default, which breaks
 * inside a linked worktree: `.git` there is a *file* (`gitdir: <path>`), not a
 * directory, so its `mkdir` throws ENOTDIR and hook installation silently fails
 * (MICA-41) — `pnpm install` scrolls an error line past and nothing is ever
 * installed.
 *
 * `git rev-parse --git-dir` resolves the right hooks directory in every case — `.git`
 * in a normal checkout, `.git/worktrees/<name>` in a linked worktree — and is exactly
 * what git's own default hook lookup already uses. Handing that path to
 * `simple-git-hooks` via a LOCAL `core.hooksPath` override, scoped to this script's own
 * run, sidesteps its buggy default without ever leaving a persistent override behind:
 * every hook in this repo is actually looked up through the machine-wide dispatcher at
 * `core.hooksPath` (global, `~/.config/git/hooks`), which chains to the file this
 * script installs — a lingering local override would silently take precedence over
 * that dispatcher instead, taking the commit-msg AI-attribution guard down with it.
 */

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const gitDir = git(['rev-parse', '--git-dir']);
const hooksDir = path.resolve(gitDir, 'hooks');

let previousHooksPath;
try {
  previousHooksPath = git(['config', '--local', 'core.hooksPath']);
} catch {
  previousHooksPath = undefined; // unset
}

git(['config', '--local', 'core.hooksPath', hooksDir]);

try {
  execFileSync('pnpm', ['exec', 'simple-git-hooks'], { stdio: 'inherit' });
} finally {
  if (previousHooksPath) {
    git(['config', '--local', 'core.hooksPath', previousHooksPath]);
  } else {
    git(['config', '--local', '--unset', 'core.hooksPath']);
  }
}
