// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

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

// A missing source is a broken checkout, not a reason to install nothing and
// report success -- the hooks here are the only gate for two of the checks.
// This is checked before the writability bail-out below, so a checkout missing
// a hook fails loudly even where nothing could have been installed anyway.
for (const hook of HOOKS) {
  if (!fs.existsSync(path.resolve('.githooks', hook))) {
    throw new Error(`install-git-hooks: .githooks/${hook} is missing`);
  }
}

// A deploy host runs `pnpm install` in a checkout whose git dir belongs to the
// human who set the stack up, not the deploy account, so this copy is EPERM
// there and taking the install down with it fails the deploy (the whole reason
// the main deploy could never run). Skipping is safe rather than fail-open: a
// machine that reaches these hooks through a global core.hooksPath dispatcher
// reads .githooks/ directly and never needed the copy, and a deploy host has no
// use for dev hooks at all. It is loud so a developer who genuinely cannot
// write .git/hooks sees why their guards are missing.
//
// Note this must survive an install nobody asked for: `pnpm build` runs its own
// dependency check, which re-invokes `pnpm install` WITHOUT the --ignore-scripts
// the deploy passes, so the flag alone does not settle it.
try {
  fs.mkdirSync(dest, { recursive: true });
  for (const hook of HOOKS) {
    const out = path.join(dest, hook);
    fs.copyFileSync(path.resolve('.githooks', hook), out);
    fs.chmodSync(out, 0o755);
  }
} catch (error) {
  if (!['EPERM', 'EACCES', 'EROFS'].includes(error.code)) throw error;
  console.warn(
    `install-git-hooks: cannot write ${dest} (${error.code}) -- skipping. ` +
      'Git hooks are NOT installed for this checkout.'
  );
  process.exit(0);
}

console.log(`install-git-hooks: installed ${HOOKS.join(', ')} into ${dest}`);
