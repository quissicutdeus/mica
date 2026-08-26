import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Copy the checked-in hooks in .githooks/ into git's default hooks directory.
 *
 * This replaced `simple-git-hooks`, which generated the same three shims from a
 * block in package.json. Two reasons the generator went:
 *
 *   - It wrote to `<projectRoot>/.git/hooks`, which is not a directory inside a
 *     linked worktree (`.git` there is a *file* holding `gitdir: <path>`), so
 *     its mkdir threw ENOTDIR and installation silently failed (MICA-41).
 *     `git rev-parse --git-dir` resolves correctly in a normal checkout, a
 *     linked worktree and a submodule alike, and is what git's own hook lookup
 *     uses.
 *   - Generated shims are not reviewable. The hooks are now ordinary files in
 *     .githooks/, so a change to one shows up in a diff like anything else.
 *
 * Why copy into .git/hooks at all, rather than just pointing core.hooksPath at
 * .githooks/: that would be a *local* override, and it would take precedence
 * over the machine-wide dispatcher some contributors run at a global
 * core.hooksPath, silently disabling every guard that lives there. .git/hooks
 * is git's default and needs no configuration, so these hooks work on a machine
 * with no dispatcher and no ~/.config -- a cloud coding-agent host, say, which
 * is exactly the case the commit-msg guard exists for. A machine that DOES run
 * such a dispatcher reaches .githooks/ directly, ahead of this copy; both paths
 * execute the same files.
 */

const HOOKS = ['pre-commit', 'commit-msg', 'pre-push'];

let gitDir;
try {
  gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
} catch {
  // Installing from a tarball rather than a checkout: there is no repository to
  // install hooks into, and that is not an error.
  console.log('install-git-hooks: not a git checkout, nothing to install.');
  process.exit(0);
}

const dest = path.resolve(gitDir, 'hooks');
fs.mkdirSync(dest, { recursive: true });

for (const hook of HOOKS) {
  const src = path.resolve('.githooks', hook);
  // A missing source is a broken checkout, not a reason to install nothing and
  // report success -- the hooks here are the only gate for two of the checks.
  if (!fs.existsSync(src)) {
    throw new Error(`install-git-hooks: .githooks/${hook} is missing`);
  }
  const out = path.join(dest, hook);
  fs.copyFileSync(src, out);
  fs.chmodSync(out, 0o755);
}

console.log(`install-git-hooks: installed ${HOOKS.join(', ')} into ${dest}`);
